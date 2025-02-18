import {
  http,
  type Address,
  type Chain,
  type GetContractReturnType,
  type Hex,
  type PublicClient,
  concat,
  concatHex,
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getContract,
  getCreate2Address,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toBytes,
  toHex,
} from "viem";
import type { IBundler } from "../bundler/IBundler.js";
import {
  Bundler,
  type UserOpResponse,
  extractChainIdFromBundlerUrl,
} from "../bundler/index.js";
import {
  BaseValidationModule,
  type ModuleInfo,
  type SendUserOpParams,
  type SessionSearchParam,
  type SessionType,
  createECDSAOwnershipValidationModule,
  getBatchSessionTxParams,
  getDanSessionTxParams,
  getSingleSessionTxParams
} from "../modules"
import type { ISessionStorage } from "../modules/interfaces/ISessionStorage.js"
import { getDefaultStorageClient } from "../modules/session-storage/utils.js"
import {
  BiconomyPaymaster,
  type FeeQuotesOrDataDto,
  type FeeQuotesOrDataResponse,
  type IHybridPaymaster,
  type IPaymaster,
  Paymaster,
  PaymasterMode,
  type SponsorUserOperationDto,
} from "../paymaster";
import {
  type BigNumberish,
  Logger,
  type SmartAccountSigner,
  type StateOverrideSet,
  type UserOperationStruct,
  convertSigner,
  getChain,
} from "./";
import { BaseSmartContractAccount } from "./BaseSmartContractAccount.js";
import { AccountResolverAbi } from "./abi/AccountResolver.js";
import { BiconomyFactoryAbi } from "./abi/Factory.js";
import { BiconomyAccountAbi } from "./abi/SmartAccount.js";
import {
  ADDRESS_RESOLVER_ADDRESS,
  ADDRESS_ZERO,
  BICONOMY_IMPLEMENTATION_ADDRESSES_BY_VERSION,
  DEFAULT_BICONOMY_FACTORY_ADDRESS,
  DEFAULT_ENTRYPOINT_ADDRESS,
  DEFAULT_FALLBACK_HANDLER_ADDRESS,
  ERC20_ABI,
  ERROR_MESSAGES,
  MAGIC_BYTES,
  NATIVE_TOKEN_ALIAS,
  PROXY_CREATION_CODE,
} from "./utils/Constants.js";
import type {
  BalancePayload,
  BatchUserOperationCallData,
  BiconomySmartAccountV2Config,
  BiconomySmartAccountV2ConfigConstructorProps,
  BiconomyTokenPaymasterRequest,
  BuildUserOpOptions,
  CounterFactualAddressParam,
  GetSessionParams,
  NonceOptions,
  PaymasterUserOperationDto,
  QueryParamsForAddressResolver,
  SimulationType,
  SupportedToken,
  Transaction,
  TransferOwnershipCompatibleModule,
  WithdrawalRequest,
} from "./utils/Types.js";
import {
  addressEquals,
  compareChainIds,
  convertToFactor,
  isNullOrUndefined,
  isValidRpcUrl,
  packUserOp,
} from "./utils/Utils.js";

type UserOperationKey = keyof UserOperationStruct;

export class BiconomySmartAccountV2 extends BaseSmartContractAccount {
  private sessionData?: ModuleInfo;

  private sessionType: SessionType | null = null

  private sessionStorageClient: ISessionStorage | undefined;

  private SENTINEL_MODULE = "0x0000000000000000000000000000000000000001"

  private index: number;

  private chainId: number;

  private provider: PublicClient;

  paymaster?: IPaymaster;

  bundler?: IBundler;

  private accountContract?: GetContractReturnType<
    typeof BiconomyAccountAbi,
    PublicClient
  >;

  private defaultFallbackHandlerAddress: Hex;

  private implementationAddress: Hex;

  private scanForUpgradedAccountsFromV1!: boolean;

  private maxIndexForScan!: number;

  // Validation module responsible for account deployment initCode. This acts as a default authorization module.
  defaultValidationModule!: BaseValidationModule;

  // Deployed Smart Account can have more than one module enabled. When sending a transaction activeValidationModule is used to prepare and validate userOp signature.
  activeValidationModule!: BaseValidationModule;

  private constructor(
    readonly biconomySmartAccountConfig: BiconomySmartAccountV2ConfigConstructorProps,
  ) {
    super({
      ...biconomySmartAccountConfig,
      chain:
        biconomySmartAccountConfig.viemChain ??
        biconomySmartAccountConfig.customChain ??
        getChain(biconomySmartAccountConfig.chainId),
      rpcClient:
        biconomySmartAccountConfig.rpcUrl ||
        getChain(biconomySmartAccountConfig.chainId).rpcUrls.default.http[0],
      entryPointAddress:
        (biconomySmartAccountConfig.entryPointAddress as Hex) ??
        DEFAULT_ENTRYPOINT_ADDRESS,
      accountAddress:
        (biconomySmartAccountConfig.accountAddress as Hex) ?? undefined,
      factoryAddress:
        biconomySmartAccountConfig.factoryAddress ??
        DEFAULT_BICONOMY_FACTORY_ADDRESS,
    });

    this.sessionData = biconomySmartAccountConfig.sessionData
    this.sessionType = biconomySmartAccountConfig.sessionType ?? null

    this.defaultValidationModule =
      biconomySmartAccountConfig.defaultValidationModule;
    this.activeValidationModule =
      biconomySmartAccountConfig.activeValidationModule;

    this.index = biconomySmartAccountConfig.index ?? 0;
    this.chainId = biconomySmartAccountConfig.chainId;
    this.bundler = biconomySmartAccountConfig.bundler;
    this.implementationAddress =
      biconomySmartAccountConfig.implementationAddress ??
      (BICONOMY_IMPLEMENTATION_ADDRESSES_BY_VERSION.V2_0_0 as Hex);

    if (biconomySmartAccountConfig.paymasterUrl) {
      this.paymaster = new Paymaster({
        paymasterUrl: biconomySmartAccountConfig.paymasterUrl,
      });
    } else if (biconomySmartAccountConfig.biconomyPaymasterApiKey) {
      this.paymaster = new Paymaster({
        paymasterUrl: `https://paymaster.biconomy.io/api/v1/${biconomySmartAccountConfig.chainId}/${biconomySmartAccountConfig.biconomyPaymasterApiKey}`,
      });
    } else {
      this.paymaster = biconomySmartAccountConfig.paymaster;
    }

    this.bundler = biconomySmartAccountConfig.bundler;

    const defaultFallbackHandlerAddress =
      this.factoryAddress === DEFAULT_BICONOMY_FACTORY_ADDRESS
        ? DEFAULT_FALLBACK_HANDLER_ADDRESS
        : biconomySmartAccountConfig.defaultFallbackHandler;
    if (!defaultFallbackHandlerAddress) {
      throw new Error("Default Fallback Handler address is not provided");
    }
    this.defaultFallbackHandlerAddress = defaultFallbackHandlerAddress;

    // Added bang operator to avoid null check as the constructor have these params as optional
    this.defaultValidationModule =
      // biome-ignore lint/style/noNonNullAssertion: <explanation>
      biconomySmartAccountConfig.defaultValidationModule!;
    this.activeValidationModule =
      // biome-ignore lint/style/noNonNullAssertion: <explanation>
      biconomySmartAccountConfig.activeValidationModule!;

    this.provider = createPublicClient({
      chain:
        biconomySmartAccountConfig.viemChain ??
        biconomySmartAccountConfig.customChain ??
        getChain(biconomySmartAccountConfig.chainId),
      transport: http(
        biconomySmartAccountConfig.rpcUrl ||
        getChain(biconomySmartAccountConfig.chainId).rpcUrls.default.http[0]
      )
    })

    this.scanForUpgradedAccountsFromV1 =
      biconomySmartAccountConfig.scanForUpgradedAccountsFromV1 ?? false
    this.maxIndexForScan = biconomySmartAccountConfig.maxIndexForScan ?? 10
    this.getAccountAddress()
    this.sessionStorageClient = biconomySmartAccountConfig.sessionStorageClient;
  }

  /**
   * Creates a new instance of BiconomySmartAccountV2
   *
   * This method will create a BiconomySmartAccountV2 instance but will not deploy the Smart Account
   * Deployment of the Smart Account will be donewith the first user operation.
   *
   * - Docs: https://docs.biconomy.io/Account/integration#integration-1
   *
   * @param biconomySmartAccountConfig - Configuration for initializing the BiconomySmartAccountV2 instance {@link BiconomySmartAccountV2Config}.
   * @returns A promise that resolves to a new instance of BiconomySmartAccountV2.
   * @throws An error if something is wrong with the smart account instance creation.
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient, BiconomySmartAccountV2 } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const bundlerUrl = "" // Retrieve bundler url from dashboard
   *
   * const smartAccountFromStaticCreate = await BiconomySmartAccountV2.create({ signer, bundlerUrl });
   *
   * // Is the same as...
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl });
   *
   */
  public static async create(
    biconomySmartAccountConfig: BiconomySmartAccountV2Config,
  ): Promise<BiconomySmartAccountV2> {
    let chainId = biconomySmartAccountConfig.chainId;
    let rpcUrl =
      biconomySmartAccountConfig.customChain?.rpcUrls?.default?.http?.[0] ??
      biconomySmartAccountConfig.rpcUrl;
    let resolvedSmartAccountSigner!: SmartAccountSigner;

    // Signer needs to be initialised here before defaultValidationModule is set
    if (biconomySmartAccountConfig.signer) {
      const signerResult = await convertSigner(
        biconomySmartAccountConfig.signer,
        !!chainId,
        rpcUrl,
      );
      if (!chainId && !!signerResult.chainId) {
        chainId = signerResult.chainId;
      }
      if (!rpcUrl && !!signerResult.rpcUrl) {
        if (isValidRpcUrl(signerResult.rpcUrl)) {
          rpcUrl = signerResult.rpcUrl;
        }
      }
      resolvedSmartAccountSigner = signerResult.signer;
    }
    if (!chainId) {
      // Get it from bundler
      if (biconomySmartAccountConfig.bundlerUrl) {
        chainId = extractChainIdFromBundlerUrl(
          biconomySmartAccountConfig.bundlerUrl,
        );
      } else if (biconomySmartAccountConfig.bundler) {
        const bundlerUrlFromBundler =
          biconomySmartAccountConfig.bundler.getBundlerUrl();
        chainId = extractChainIdFromBundlerUrl(bundlerUrlFromBundler);
      }
    }
    if (!chainId) {
      throw new Error("chainId required");
    }
    const bundler: IBundler =
      biconomySmartAccountConfig.bundler ??
      new Bundler({
        // biome-ignore lint/style/noNonNullAssertion: always required
        bundlerUrl: biconomySmartAccountConfig.bundlerUrl!,
        chainId,
        customChain:
          biconomySmartAccountConfig.viemChain ??
          biconomySmartAccountConfig.customChain ??
          getChain(chainId),
      });
    let defaultValidationModule =
      biconomySmartAccountConfig.defaultValidationModule;

    // Note: If no module is provided, we will use ECDSA_OWNERSHIP as default
    if (!defaultValidationModule) {
      const newModule = await createECDSAOwnershipValidationModule({
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        signer: resolvedSmartAccountSigner!,
      });
      defaultValidationModule = newModule;
    }
    const activeValidationModule =
      biconomySmartAccountConfig?.activeValidationModule ??
      defaultValidationModule;
    if (!resolvedSmartAccountSigner) {
      resolvedSmartAccountSigner = await activeValidationModule.getSigner();
    }
    if (!resolvedSmartAccountSigner) {
      throw new Error("signer required");
    }

    const config: BiconomySmartAccountV2ConfigConstructorProps = {
      ...biconomySmartAccountConfig,
      defaultValidationModule,
      activeValidationModule,
      chainId,
      bundler,
      signer: resolvedSmartAccountSigner,
      rpcUrl,
    };

    // We check if chain ids match (skip this if chainId is passed by in the config)
    // This check is at the end of the function for cases when the signer is not passed in the config but a validation modules is and we get the signer from the validation module in this case
    if (
      biconomySmartAccountConfig.skipChainCheck !== true &&
      !biconomySmartAccountConfig.chainId
    ) {
      await compareChainIds(
        biconomySmartAccountConfig.signer || resolvedSmartAccountSigner,
        config,
        false,
      );
    }

    return new BiconomySmartAccountV2(config);
  }

  // Calls the getCounterFactualAddress
  override async getAddress(params?: CounterFactualAddressParam): Promise<Hex> {
    if (this.accountAddress == null) {
      // means it needs deployment
      this.accountAddress = await this.getCounterFactualAddress(params);
    }
    return this.accountAddress;
  }

  // Calls the getCounterFactualAddress
  async getAccountAddress(
    params?: CounterFactualAddressParam,
  ): Promise<`0x${string}`> {
    if (this.accountAddress == null || this.accountAddress === undefined) {
      // means it needs deployment
      this.accountAddress = await this.getCounterFactualAddress(params);
    }
    return this.accountAddress;
  }

  /**
   * Returns an upper estimate for the gas spent on a specific user operation
   *
   * This method will fetch an approximate gas estimate for the user operation, given the current state of the network.
   * It is regularly an overestimate, and the actual gas spent will likely be lower.
   * It is unlikely to be an underestimate unless the network conditions rapidly change.
   *
   * @param transactions Array of {@link Transaction} to be sent.
   * @param buildUseropDto {@link BuildUserOpOptions}.
   * @returns Promise<bigint> - The estimated gas cost in wei.
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl, paymasterUrl }); // Retrieve bundler/paymaster url from dashboard
   * const encodedCall = encodeFunctionData({
   *   abi: parseAbi(["function safeMint(address to) public"]),
   *   functionName: "safeMint",
   *   args: ["0x..."],
   * });
   *
   * const tx = {
   *   to: nftAddress,
   *   data: encodedCall
   * }
   *
   * const amountInWei = await smartAccount.getGasEstimates([tx, tx], {
   *    paymasterServiceData: {
   *      mode: PaymasterMode.SPONSORED,
   *    },
   * });
   *
   * console.log(amountInWei.toString());
   *
   */
  public async getGasEstimate(
    transactions: Transaction[],
    buildUseropDto?: BuildUserOpOptions,
  ): Promise<bigint> {
    const {
      callGasLimit,
      preVerificationGas,
      verificationGasLimit,
      maxFeePerGas,
    } = await this.buildUserOp(transactions, buildUseropDto);

    const _callGasLimit = BigInt(callGasLimit || 0);
    const _preVerificationGas = BigInt(preVerificationGas || 0);
    const _verificationGasLimit = BigInt(verificationGasLimit || 0);
    const _maxFeePerGas = BigInt(maxFeePerGas || 0);

    if (!buildUseropDto?.paymasterServiceData?.mode) {
      return (
        (_callGasLimit + _preVerificationGas + _verificationGasLimit) *
        _maxFeePerGas
      );
    }
    return (
      (_callGasLimit +
        BigInt(3) * _verificationGasLimit +
        _preVerificationGas) *
      _maxFeePerGas
    );
  }

  /**
   * Returns balances for the smartAccount instance.
   *
   * This method will fetch tokens info given an array of token addresses for the smartAccount instance.
   * The balance of the native token will always be returned as the last element in the reponse array, with the address set to 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE.
   *
   * @param addresses - Optional. Array of asset addresses to fetch the balances of. If not provided, the method will return only the balance of the native token.
   * @returns Promise<Array<BalancePayload>> - An array of token balances (plus the native token balance) of the smartAccount instance.
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const token = "0x747A4168DB14F57871fa8cda8B5455D8C2a8e90a";
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl });
   * const [tokenBalanceFromSmartAccount, nativeTokenBalanceFromSmartAccount] = await smartAccount.getBalances([token]);
   *
   * console.log(tokenBalanceFromSmartAccount);
   * // {
   * //   amount: 1000000000000000n,
   * //   decimals: 6,
   * //   address: "0x747A4168DB14F57871fa8cda8B5455D8C2a8e90a",
   * //   formattedAmount: "1000000",
   * //   chainId: 80002
   * // }
   *
   * // or to get the nativeToken balance
   *
   * const [nativeTokenBalanceFromSmartAccount] = await smartAccount.getBalances();
   *
   * console.log(nativeTokenBalanceFromSmartAccount);
   * // {
   * //   amount: 1000000000000000n,
   * //   decimals: 18,
   * //   address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
   * //   formattedAmount: "1",
   * //   chainId: 80002
   * // }
   *
   */
  public async getBalances(
    addresses?: Array<Hex>,
  ): Promise<Array<BalancePayload>> {
    const accountAddress = await this.getAccountAddress();
    const result: BalancePayload[] = [];

    if (addresses) {
      const tokenContracts = addresses.map((address) =>
        getContract({
          address,
          abi: parseAbi(ERC20_ABI),
          client: this.provider,
        }),
      );

      const balancePromises = tokenContracts.map((tokenContract) =>
        tokenContract.read.balanceOf([accountAddress]),
      ) as Promise<bigint>[];
      const decimalsPromises = tokenContracts.map((tokenContract) =>
        tokenContract.read.decimals(),
      ) as Promise<number>[];
      const [balances, decimalsPerToken] = await Promise.all([
        Promise.all(balancePromises),
        Promise.all(decimalsPromises),
      ]);

      balances.forEach((amount, index) =>
        result.push({
          amount,
          decimals: decimalsPerToken[index],
          address: addresses[index],
          formattedAmount: formatUnits(amount, decimalsPerToken[index]),
          chainId: this.chainId,
        }),
      );
    }

    const balance = await this.provider.getBalance({ address: accountAddress });

    result.push({
      amount: balance,
      decimals: 18,
      address: NATIVE_TOKEN_ALIAS,
      formattedAmount: formatUnits(balance, 18),
      chainId: this.chainId,
    });

    return result;
  }

  /**
   * Transfers funds from Smart Account to recipient (usually EOA)
   * @param recipient - Address of the recipient
   * @param withdrawalRequests - Array of withdrawal requests {@link WithdrawalRequest}. If withdrawal request is an empty array, it will transfer the balance of the native token. Using a paymaster will ensure no dust remains in the smart account.
   * @param buildUseropDto - Optional. {@link BuildUserOpOptions}
   *
   * @returns Promise<UserOpResponse> - An object containing the status of the transaction.
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient, NATIVE_TOKEN_ALIAS } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonMumbai } from "viem/chains";
   *
   * const token = "0x747A4168DB14F57871fa8cda8B5455D8C2a8e90a";
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonMumbai,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl, biconomyPaymasterApiKey });
   *
   * const { wait } = await smartAccount.withdraw(
   *  [
   *    { address: token }, // omit the amount to withdraw the full balance
   *    { address: NATIVE_TOKEN_ALIAS, amount: 1n }
   *  ],
   *  account.address, // Default recipient used if no recipient is present in the withdrawal request
   *  {
   *    paymasterServiceData: { mode: PaymasterMode.SPONSORED },
   *  }
   * );
   *
   * // OR to withdraw all of the native token, leaving no dust in the smart account
   *
   * const { wait } = await smartAccount.withdraw([], account.address, {
   *  paymasterServiceData: { mode: PaymasterMode.SPONSORED },
   * });
   *
   * const { success } = await wait();
   */
  public async withdraw(
    withdrawalRequests?: WithdrawalRequest[] | null,
    defaultRecipient?: Hex | null,
    buildUseropDto?: BuildUserOpOptions,
  ): Promise<UserOpResponse> {
    const accountAddress =
      this.accountAddress ?? (await this.getAccountAddress());

    if (
      !defaultRecipient &&
      withdrawalRequests?.some(({ recipient }) => !recipient)
    ) {
      throw new Error(ERROR_MESSAGES.NO_RECIPIENT);
    }

    // Remove the native token from the withdrawal requests
    let tokenRequests =
      withdrawalRequests?.filter(
        ({ address }) => !addressEquals(address, NATIVE_TOKEN_ALIAS),
      ) ?? [];

    // Check if the amount is not present in all withdrawal requests
    const shouldFetchMaxBalances = tokenRequests.some(({ amount }) => !amount);

    // Get the balances of the tokens if the amount is not present in the withdrawal requests
    if (shouldFetchMaxBalances) {
      const balances = await this.getBalances(
        tokenRequests.map(({ address }) => address),
      );
      tokenRequests = tokenRequests.map(({ amount, address }, i) => ({
        address,
        amount: amount ?? balances[i].amount,
      }));
    }

    // Create the transactions
    const txs: Transaction[] = tokenRequests.map(
      ({ address, amount, recipient: recipientFromRequest }) => ({
        to: address,
        data: encodeFunctionData({
          abi: parseAbi(ERC20_ABI),
          functionName: "transfer",
          args: [recipientFromRequest || defaultRecipient, amount],
        }),
      }),
    );

    // Check if eth alias is present in the original withdrawal requests
    const nativeTokenRequest = withdrawalRequests?.find(({ address }) =>
      addressEquals(address, NATIVE_TOKEN_ALIAS),
    );
    const hasNoRequests = !withdrawalRequests?.length;
    if (!!nativeTokenRequest || hasNoRequests) {
      // Check that an amount is present in the withdrawal request, if no paymaster service data is present, as max amounts cannot be calculated without a paymaster.
      if (
        !nativeTokenRequest?.amount &&
        !buildUseropDto?.paymasterServiceData?.mode
      ) {
        throw new Error(ERROR_MESSAGES.NATIVE_TOKEN_WITHDRAWAL_WITHOUT_AMOUNT);
      }

      // get eth balance if not present in withdrawal requests
      const nativeTokenAmountToWithdraw =
        nativeTokenRequest?.amount ??
        (await this.provider.getBalance({ address: accountAddress }));

      txs.push({
        to: (nativeTokenRequest?.recipient ?? defaultRecipient) as Hex,
        value: nativeTokenAmountToWithdraw,
      });
    }

    return this.sendTransaction(txs, buildUseropDto);
  }

  /**
   * Return the account's address. This value is valid even before deploying the contract.
   */
  async getCounterFactualAddress(
    params?: CounterFactualAddressParam,
  ): Promise<Hex> {
    const validationModule =
      params?.validationModule ?? this.defaultValidationModule;
    const index = params?.index ?? this.index;

    const maxIndexForScan = params?.maxIndexForScan ?? this.maxIndexForScan;
    // Review: default behavior
    const scanForUpgradedAccountsFromV1 =
      params?.scanForUpgradedAccountsFromV1 ??
      this.scanForUpgradedAccountsFromV1;

    // if it's intended to detect V1 upgraded accounts
    if (scanForUpgradedAccountsFromV1) {
      const eoaSigner = await validationModule.getSigner();
      const eoaAddress = (await eoaSigner.getAddress()) as Hex;
      const moduleAddress = validationModule.getAddress() as Hex;
      const moduleSetupData = (await validationModule.getInitData()) as Hex;
      const queryParams = {
        eoaAddress,
        index,
        moduleAddress,
        moduleSetupData,
        maxIndexForScan,
      };
      const accountAddress = await this.getV1AccountsUpgradedToV2(queryParams);
      if (accountAddress !== ADDRESS_ZERO) {
        return accountAddress;
      }
    }

    const counterFactualAddressV2 = await this.getCounterFactualAddressV2({
      validationModule,
      index,
    });
    return counterFactualAddressV2;
  }

  private async getCounterFactualAddressV2(
    params?: CounterFactualAddressParam,
  ): Promise<Hex> {
    const validationModule =
      params?.validationModule ?? this.defaultValidationModule;
    const index = params?.index ?? this.index;

    try {
      const initCalldata = encodeFunctionData({
        abi: BiconomyAccountAbi,
        functionName: "init",
        args: [
          this.defaultFallbackHandlerAddress,
          validationModule.getAddress() as Hex,
          (await validationModule.getInitData()) as Hex,
        ],
      });

      const proxyCreationCodeHash = keccak256(
        encodePacked(
          ["bytes", "uint256"],
          [PROXY_CREATION_CODE, BigInt(this.implementationAddress)],
        ),
      );

      const salt = keccak256(
        encodePacked(
          ["bytes32", "uint256"],
          [keccak256(initCalldata), BigInt(index)],
        ),
      );

      const counterFactualAddress = getCreate2Address({
        from: this.factoryAddress,
        salt: salt,
        bytecodeHash: proxyCreationCodeHash,
      });

      return counterFactualAddress;
    } catch (e) {
      throw new Error(`Failed to get counterfactual address, ${e}`);
    }
  }

  async _getAccountContract(): Promise<
    GetContractReturnType<typeof BiconomyAccountAbi, PublicClient>
  > {
    if (this.accountContract == null) {
      this.accountContract = getContract({
        address: await this.getAddress(),
        abi: BiconomyAccountAbi,
        client: this.provider as PublicClient,
      });
    }
    return this.accountContract;
  }

  isActiveValidationModuleDefined(): boolean {
    if (!this.activeValidationModule)
      throw new Error("Must provide an instance of active validation module.");
    return true;
  }

  isDefaultValidationModuleDefined(): boolean {
    if (!this.defaultValidationModule)
      throw new Error("Must provide an instance of default validation module.");
    return true;
  }

  setActiveValidationModule(
    validationModule: BaseValidationModule,
  ): BiconomySmartAccountV2 {
    if (validationModule instanceof BaseValidationModule) {
      this.activeValidationModule = validationModule;
    }
    return this;
  }

  setDefaultValidationModule(
    validationModule: BaseValidationModule,
  ): BiconomySmartAccountV2 {
    if (validationModule instanceof BaseValidationModule) {
      this.defaultValidationModule = validationModule;
    }
    return this;
  }

  async getV1AccountsUpgradedToV2(
    params: QueryParamsForAddressResolver,
  ): Promise<Hex> {
    const maxIndexForScan = params.maxIndexForScan ?? this.maxIndexForScan;

    const addressResolver = getContract({
      address: ADDRESS_RESOLVER_ADDRESS,
      abi: AccountResolverAbi,
      client: {
        public: this.provider as PublicClient,
      },
    });
    // Note: depending on moduleAddress and moduleSetupData passed call this. otherwise could call resolveAddresses()

    if (params.moduleAddress && params.moduleSetupData) {
      const result = await addressResolver.read.resolveAddressesFlexibleForV2([
        params.eoaAddress,
        maxIndexForScan,
        params.moduleAddress,
        params.moduleSetupData,
      ]);

      const desiredV1Account = result.find(
        (smartAccountInfo: {
          factoryVersion: string;
          currentVersion: string;
          deploymentIndex: { toString: () => string };
        }) =>
          smartAccountInfo.factoryVersion === "v1" &&
          smartAccountInfo.currentVersion === "2.0.0" &&
          Number(smartAccountInfo.deploymentIndex.toString()) === params.index,
      );

      if (desiredV1Account) {
        const smartAccountAddress = desiredV1Account.accountAddress;
        return smartAccountAddress;
      }
      return ADDRESS_ZERO;
    }
    return ADDRESS_ZERO;
  }

  /**
   * Return the value to put into the "initCode" field, if the account is not yet deployed.
   * This value holds the "factory" address, followed by this account's information
   */
  async getAccountInitCode(): Promise<Hex> {
    this.isDefaultValidationModuleDefined();

    if (await this.isAccountDeployed()) return "0x";

    return concatHex([
      this.factoryAddress as Hex,
      (await this.getFactoryData()) ?? "0x",
    ]);
  }

  /**
   *
   * @param to { target } address of transaction
   * @param value  represents amount of native tokens
   * @param data represent data associated with transaction
   * @returns encoded data for execute function
   */
  async encodeExecute(to: Hex, value: bigint, data: Hex): Promise<Hex> {
    // return accountContract.interface.encodeFunctionData("execute_ncC", [to, value, data]) as Hex;
    return encodeFunctionData({
      abi: BiconomyAccountAbi,
      functionName: "execute_ncC",
      args: [to, value, data],
    });
  }

  /**
   *
   * @param to { target } array of addresses in transaction
   * @param value  represents array of amount of native tokens associated with each transaction
   * @param data represent array of data associated with each transaction
   * @returns encoded data for executeBatch function
   */
  async encodeExecuteBatch(
    to: Array<Hex>,
    value: Array<bigint>,
    data: Array<Hex>,
  ): Promise<Hex> {
    return encodeFunctionData({
      abi: BiconomyAccountAbi,
      functionName: "executeBatch_y6U",
      args: [to, value, data],
    });
  }

  override async encodeBatchExecute(
    txs: BatchUserOperationCallData,
  ): Promise<Hex> {
    const [targets, datas, value] = txs.reduce(
      (accum, curr) => {
        accum[0].push(curr.target);
        accum[1].push(curr.data);
        accum[2].push(curr.value || BigInt(0));

        return accum;
      },
      [[], [], []] as [Hex[], Hex[], bigint[]],
    );

    return this.encodeExecuteBatch(targets, value, datas);
  }

  // dummy signature depends on the validation module supplied.
  async getDummySignatures(params?: ModuleInfo): Promise<Hex> {
    const defaultedParams = {
      ...(this.sessionData ? this.sessionData : {}),
      ...params
    }

    this.isActiveValidationModuleDefined()
    return (await this.activeValidationModule.getDummySignature(
      defaultedParams
    )) as Hex
  }

  // TODO: review this
  getDummySignature(): Hex {
    throw new Error("Method not implemented! Call getDummySignatures instead.");
  }

  // Might use provided paymaster instance to get dummy data (from pm service)
  getDummyPaymasterData(): string {
    return "0x";
  }

  validateUserOp(
    userOp: Partial<UserOperationStruct>,
    requiredFields: UserOperationKey[],
  ): boolean {
    for (const field of requiredFields) {
      if (isNullOrUndefined(userOp[field])) {
        throw new Error(`${String(field)} is missing in the UserOp`);
      }
    }
    return true;
  }

  async signUserOp(
    userOp: Partial<UserOperationStruct>,
    params?: SendUserOpParams
  ): Promise<UserOperationStruct> {
    const defaultedParams = {
      ...(this.sessionData ? this.sessionData : {}),
      ...params,
      rawUserOperation: userOp
    }
    this.isActiveValidationModuleDefined()
    const requiredFields: UserOperationKey[] = [
      "sender",
      "nonce",
      "initCode",
      "callData",
      "callGasLimit",
      "verificationGasLimit",
      "preVerificationGas",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "paymasterAndData"
    ]
    this.validateUserOp(userOp, requiredFields)

    const userOpHash = await this.getUserOpHash(userOp)

    const moduleSig = (await this.activeValidationModule.signUserOpHash(
      userOpHash,
      defaultedParams
    )) as Hex

    const signatureWithModuleAddress = this.getSignatureWithModuleAddress(
      moduleSig,
      this.activeValidationModule.getAddress() as Hex,
    );

    userOp.signature = signatureWithModuleAddress

    return userOp as UserOperationStruct
  }

  getSignatureWithModuleAddress(
    moduleSignature: Hex,
    moduleAddress?: Hex,
  ): Hex {
    const moduleAddressToUse =
      moduleAddress ?? (this.activeValidationModule.getAddress() as Hex)
    const result = encodeAbiParameters(parseAbiParameters("bytes, address"), [
      moduleSignature,
      moduleAddressToUse
    ])

    return result
  }

  public async getPaymasterUserOp(
    userOp: Partial<UserOperationStruct>,
    paymasterServiceData: PaymasterUserOperationDto,
  ): Promise<Partial<UserOperationStruct>> {
    if (paymasterServiceData.mode === PaymasterMode.SPONSORED) {
      return this.getPaymasterAndData(userOp, paymasterServiceData);
    }
    if (paymasterServiceData.mode === PaymasterMode.ERC20) {
      if (paymasterServiceData?.feeQuote) {
        const { feeQuote, spender, maxApproval = false } = paymasterServiceData;
        Logger.log("there is a feeQuote: ", JSON.stringify(feeQuote, null, 2));
        if (!spender) throw new Error(ERROR_MESSAGES.SPENDER_REQUIRED);
        if (!feeQuote) throw new Error(ERROR_MESSAGES.FAILED_FEE_QUOTE_FETCH);
        if (
          paymasterServiceData.skipPatchCallData &&
          paymasterServiceData.skipPatchCallData === true
        ) {
          return this.getPaymasterAndData(userOp, {
            ...paymasterServiceData,
            feeTokenAddress: feeQuote.tokenAddress,
          });
        }
        const partialUserOp = await this.buildTokenPaymasterUserOp(userOp, {
          ...paymasterServiceData,
          spender,
          maxApproval,
          feeQuote,
        });
        return this.getPaymasterAndData(partialUserOp, {
          ...paymasterServiceData,
          feeTokenAddress: feeQuote.tokenAddress,
          calculateGasLimits: paymasterServiceData.calculateGasLimits ?? true, // Always recommended and especially when using token paymaster
        });
      }
      if (paymasterServiceData?.preferredToken) {
        const { preferredToken } = paymasterServiceData;
        Logger.log("there is a preferred token: ", preferredToken);
        const feeQuotesResponse = await this.getPaymasterFeeQuotesOrData(
          userOp,
          paymasterServiceData,
        );
        const spender = feeQuotesResponse.tokenPaymasterAddress;
        const feeQuote = feeQuotesResponse.feeQuotes?.[0];
        if (!spender) throw new Error(ERROR_MESSAGES.SPENDER_REQUIRED);
        if (!feeQuote) throw new Error(ERROR_MESSAGES.FAILED_FEE_QUOTE_FETCH);
        return this.getPaymasterUserOp(userOp, {
          ...paymasterServiceData,
          feeQuote,
          spender,
        }); // Recursively call getPaymasterUserOp with the feeQuote
      }
      Logger.log(
        "ERC20 mode without feeQuote or preferredToken provided. Passing through unchanged.",
      );
      return userOp;
    }
    throw new Error("Invalid paymaster mode");
  }

  private async getPaymasterAndData(
    userOp: Partial<UserOperationStruct>,
    paymasterServiceData: PaymasterUserOperationDto,
  ): Promise<Partial<UserOperationStruct>> {
    const paymaster = this
      .paymaster as IHybridPaymaster<PaymasterUserOperationDto>;
    const paymasterData = await paymaster.getPaymasterAndData(
      userOp,
      paymasterServiceData,
    );
    return { ...userOp, ...paymasterData };
  }

  private async getPaymasterFeeQuotesOrData(
    userOp: Partial<UserOperationStruct>,
    feeQuotesOrData: FeeQuotesOrDataDto,
  ): Promise<FeeQuotesOrDataResponse> {
    const paymaster = this
      .paymaster as IHybridPaymaster<PaymasterUserOperationDto>;
    const tokenList = feeQuotesOrData?.preferredToken
      ? [feeQuotesOrData?.preferredToken]
      : feeQuotesOrData?.tokenList?.length
        ? feeQuotesOrData?.tokenList
        : [];
    return paymaster.getPaymasterFeeQuotesOrData(userOp, {
      ...feeQuotesOrData,
      tokenList,
    });
  }

  /**
   *
   * @description This function will retrieve fees from the paymaster in erc20 mode
   *
   * @param manyOrOneTransactions Array of {@link Transaction} to be batched and sent. Can also be a single {@link Transaction}.
   * @param buildUseropDto {@link BuildUserOpOptions}.
   * @returns Promise<FeeQuotesOrDataResponse>
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl }); // Retrieve bundler url from dashboard
   * const encodedCall = encodeFunctionData({
   *   abi: parseAbi(["function safeMint(address to) public"]),
   *   functionName: "safeMint",
   *   args: ["0x..."],
   * });
   *
   * const transaction = {
   *   to: nftAddress,
   *   data: encodedCall
   * }
   *
   * const feeQuotesResponse: FeeQuotesOrDataResponse = await smartAccount.getTokenFees(transaction, { paymasterServiceData: { mode: PaymasterMode.ERC20 } });
   *
   * const userSeletedFeeQuote = feeQuotesResponse.feeQuotes?.[0];
   *
   * const { wait } = await smartAccount.sendTransaction(transaction, {
   *    paymasterServiceData: {
   *      mode: PaymasterMode.ERC20,
   *      feeQuote: userSeletedFeeQuote,
   *      spender: feeQuotesResponse.tokenPaymasterAddress,
   *    },
   * });
   *
   * const { success, receipt } = await wait();
   *
   */
  public async getTokenFees(
    manyOrOneTransactions: Transaction | Transaction[],
    buildUseropDto: BuildUserOpOptions,
  ): Promise<FeeQuotesOrDataResponse> {
    const txs = Array.isArray(manyOrOneTransactions)
      ? manyOrOneTransactions
      : [manyOrOneTransactions];
    const userOp = await this.buildUserOp(txs, buildUseropDto);
    if (!buildUseropDto.paymasterServiceData)
      throw new Error("paymasterServiceData was not provided");
    return this.getPaymasterFeeQuotesOrData(
      userOp,
      buildUseropDto.paymasterServiceData,
    );
  }

  /**
   *
   * @description This function will return an array of supported tokens from the erc20 paymaster associated with the Smart Account
   * @returns Promise<{@link SupportedToken}>
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl, biconomyPaymasterApiKey }); // Retrieve bundler url from dashboard
   * const tokens = await smartAccount.getSupportedTokens();
   *
   * // [
   * //   {
   * //     symbol: "USDC",
   * //     tokenAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
   * //     decimal: 6,
   * //     logoUrl: "https://assets.coingecko.com/coins/images/279/large/usd-coin.png?1595353707",
   * //     premiumPercentage: 0.1,
   * //   }
   * // ]
   *
   */
  public async getSupportedTokens(): Promise<SupportedToken[]> {
    const feeQuotesResponse = await this.getTokenFees(
      {
        data: "0x",
        value: BigInt(0),
        to: await this.getAccountAddress(),
      },
      {
        paymasterServiceData: { mode: PaymasterMode.ERC20 },
      },
    );

    return await Promise.all(
      (feeQuotesResponse?.feeQuotes ?? []).map(async (quote) => {
        const [tokenBalance] = await this.getBalances([
          quote.tokenAddress as Hex,
        ]);
        return {
          symbol: quote.symbol,
          tokenAddress: quote.tokenAddress,
          decimal: quote.decimal,
          logoUrl: quote.logoUrl,
          premiumPercentage: quote.premiumPercentage,
          balance: tokenBalance,
        };
      }),
    );
  }

  /**
   *
   * @param userOp
   * @param params
   * @description This function will take a user op as an input, sign it with the owner key, and send it to the bundler.
   * @returns Promise<UserOpResponse>
   * Sends a user operation
   *
   * - Docs: https://docs.biconomy.io/Account/methods#senduserop-
   *
   * @param userOp Partial<{@link UserOperationStruct}> the userOp params to be sent.
   * @param params {@link SendUserOpParams}.
   * @returns Promise<{@link UserOpResponse}> that you can use to track the user operation.
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl }); // Retrieve bundler url from dashboard
   * const encodedCall = encodeFunctionData({
   *   abi: parseAbi(["function safeMint(address to) public"]),
   *   functionName: "safeMint",
   *   args: ["0x..."],
   * });
   *
   * const transaction = {
   *   to: nftAddress,
   *   data: encodedCall
   * }
   *
   * const userOp = await smartAccount.buildUserOp([transaction]);
   *
   * const { wait } = await smartAccount.sendUserOp(userOp);
   * const { success, receipt } = await wait();
   *
   */
  async sendUserOp(
    userOp: Partial<UserOperationStruct>,
    params?: SendUserOpParams,
  ): Promise<UserOpResponse> {
    // biome-ignore lint/performance/noDelete: <explanation>
    delete userOp.signature;
    const userOperation = await this.signUserOp(userOp, params);

    const bundlerResponse = await this.sendSignedUserOp(userOperation)

    return bundlerResponse;
  }

  /**
   *
   * @param userOp - The signed user operation to send
   * @param simulationType - The type of simulation to perform ("validation" | "validation_and_execution")
   * @description This function call will take 'signedUserOp' as input and send it to the bundler
   * @returns
   */
  async sendSignedUserOp(
    userOp: UserOperationStruct,
    simulationType?: SimulationType,
  ): Promise<UserOpResponse> {
    const requiredFields: UserOperationKey[] = [
      "sender",
      "nonce",
      "initCode",
      "callData",
      "callGasLimit",
      "verificationGasLimit",
      "preVerificationGas",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "paymasterAndData",
      "signature",
    ];
    this.validateUserOp(userOp, requiredFields);
    if (!this.bundler) throw new Error("Bundler is not provided");
    Logger.warn(
      "userOp being sent to the bundler",
      JSON.stringify(userOp, null, 2),
    );
    const bundlerResponse = await this.bundler.sendUserOp(
      userOp,
      simulationType,
    );
    return bundlerResponse;
  }

  async getUserOpHash(userOp: Partial<UserOperationStruct>): Promise<Hex> {
    const userOpHash = keccak256(packUserOp(userOp, true) as Hex);
    const enc = encodeAbiParameters(
      parseAbiParameters("bytes32, address, uint256"),
      [userOpHash, this.entryPoint.address, BigInt(this.chainId)],
    );
    return keccak256(enc);
  }

  async estimateUserOpGas(
    userOp: Partial<UserOperationStruct>,
    stateOverrideSet?: StateOverrideSet,
  ): Promise<Partial<UserOperationStruct>> {
    if (!this.bundler) throw new Error("Bundler is not provided");
    const requiredFields: UserOperationKey[] = [
      "sender",
      "nonce",
      "initCode",
      "callData",
    ];
    this.validateUserOp(userOp, requiredFields);

    const finalUserOp = userOp;

    // Making call to bundler to get gas estimations for userOp
    const {
      callGasLimit,
      verificationGasLimit,
      preVerificationGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    } = await this.bundler.estimateUserOpGas(userOp, stateOverrideSet);
    // if neither user sent gas fee nor the bundler, estimate gas from provider
    if (
      !userOp.maxFeePerGas &&
      !userOp.maxPriorityFeePerGas &&
      (!maxFeePerGas || !maxPriorityFeePerGas)
    ) {
      const feeData = await this.provider.estimateFeesPerGas();
      if (feeData.maxFeePerGas?.toString()) {
        finalUserOp.maxFeePerGas = `0x${feeData.maxFeePerGas.toString(
          16,
        )}` as Hex;
      } else if (feeData.gasPrice?.toString()) {
        finalUserOp.maxFeePerGas = `0x${feeData.gasPrice.toString(16)}` as Hex;
      } else {
        finalUserOp.maxFeePerGas =
          `0x${(await this.provider.getGasPrice()).toString(16)}` as Hex;
      }

      if (feeData.maxPriorityFeePerGas?.toString()) {
        finalUserOp.maxPriorityFeePerGas =
          `0x${feeData.maxPriorityFeePerGas?.toString()}` as Hex;
      } else if (feeData.gasPrice?.toString()) {
        finalUserOp.maxPriorityFeePerGas = toHex(
          Number(feeData.gasPrice?.toString()),
        );
      } else {
        finalUserOp.maxPriorityFeePerGas =
          `0x${(await this.provider.getGasPrice()).toString(16)}` as Hex;
      }
    } else {
      finalUserOp.maxFeePerGas =
        toHex(Number(maxFeePerGas)) ?? userOp.maxFeePerGas;
      finalUserOp.maxPriorityFeePerGas =
        toHex(Number(maxPriorityFeePerGas)) ?? userOp.maxPriorityFeePerGas;
    }
    finalUserOp.verificationGasLimit =
      toHex(Number(verificationGasLimit)) ?? userOp.verificationGasLimit;
    finalUserOp.callGasLimit =
      toHex(Number(callGasLimit)) ?? userOp.callGasLimit;
    finalUserOp.preVerificationGas =
      toHex(Number(preVerificationGas)) ?? userOp.preVerificationGas;
    if (!finalUserOp.paymasterAndData) {
      finalUserOp.paymasterAndData = "0x";
    }

    return finalUserOp;
  }

  override async getNonce(nonceKey?: number): Promise<bigint> {
    const nonceSpace = nonceKey ?? 0;
    try {
      const address = await this.getAddress();
      return await this.entryPoint.read.getNonce([address, BigInt(nonceSpace)]);
    } catch (e) {
      return BigInt(0);
    }
  }

  private async getBuildUserOpNonce(
    nonceOptions: NonceOptions | undefined,
  ): Promise<BigNumberish> {
    let nonce = BigInt(0);
    try {
      if (nonceOptions?.nonceOverride) {
        nonce = BigInt(nonceOptions?.nonceOverride);
      } else {
        const _nonceSpace = nonceOptions?.nonceKey ?? 0;
        nonce = await this.getNonce(_nonceSpace);
      }
    } catch (error) {
      // Not throwing this error as nonce would be 0 if this.getNonce() throw exception, which is expected flow for undeployed account
      Logger.warn(
        "Error while getting nonce for the account. This is expected for undeployed accounts set nonce to 0",
      );
    }
    return nonce;
  }

  /**
   * Transfers ownership of the smart account to a new owner.
   * @param newOwner The address of the new owner.
   * @param moduleAddress {@link TransferOwnershipCompatibleModule} The address of the validation module (ECDSA Ownership Module or Multichain Validation Module).
   * @param buildUseropDto {@link BuildUserOpOptions}. Optional parameter
   * @returns A Promise that resolves to a UserOpResponse or rejects with an Error.
   * @description This function will transfer ownership of the smart account to a new owner. If you use session key manager module, after transferring the ownership
   * you will need to re-create a session for the smart account with the new owner (signer) and specify "accountAddress" in "createSmartAccountClient" function.
   * @example
   * 
   * let walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http()
      });

      let smartAccount = await createSmartAccountClient({
        signer: walletClient,
        paymasterUrl: "https://paymaster.biconomy.io/api/v1/...",
        bundlerUrl: `https://bundler.biconomy.io/api/v2/84532/nJPK7B3ru.dd7f7861-190d-41bd-af80-6877f74b8f44`,
        chainId: 84532
      });
      const response = await smartAccount.transferOwnership(newOwner, DEFAULT_ECDSA_OWNERSHIP_MODULE, {paymasterServiceData: {mode: PaymasterMode.SPONSORED}});
      
      walletClient = createWalletClient({
        newOwnerAccount,
        chain: baseSepolia,
        transport: http()
      })
      
      smartAccount = await createSmartAccountClient({
        signer: walletClient,
        paymasterUrl: "https://paymaster.biconomy.io/api/v1/...",
        bundlerUrl: `https://bundler.biconomy.io/api/v2/84532/nJPK7B3ru.dd7f7861-190d-41bd-af80-6877f74b8f44`,
        chainId: 84532,
        accountAddress: await smartAccount.getAccountAddress()
      })
   */
  async transferOwnership(
    newOwner: Address,
    moduleAddress: TransferOwnershipCompatibleModule,
    buildUseropDto?: BuildUserOpOptions,
  ): Promise<UserOpResponse> {
    const encodedCall = encodeFunctionData({
      abi: parseAbi(["function transferOwnership(address newOwner) public"]),
      functionName: "transferOwnership",
      args: [newOwner],
    });
    const transaction = {
      to: moduleAddress,
      data: encodedCall,
    };
    const userOpResponse: UserOpResponse = await this.sendTransaction(
      transaction,
      buildUseropDto,
    );
    return userOpResponse;
  }

  /**
   * Sends a transaction (builds and sends a user op in sequence)
   *
   * - Docs: https://docs.biconomy.io/Account/methods#sendtransaction-
   *
   * @param manyOrOneTransactions Array of {@link Transaction} to be batched and sent. Can also be a single {@link Transaction}.
   * @param buildUseropDto {@link BuildUserOpOptions}.
   * @param sessionData - Optional parameter. If you are using session keys, you can pass the sessionIds, the session and the storage client to retrieve the session data while sending a tx {@link GetSessionParams}
   * @returns Promise<{@link UserOpResponse}> that you can use to track the user operation.
   *
   * @example
   * ```ts
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl }); // Retrieve bundler url from dashboard
   * const encodedCall = encodeFunctionData({
   *   abi: parseAbi(["function safeMint(address to) public"]),
   *   functionName: "safeMint",
   *   args: ["0x..."],
   * });
   *
   * const transaction = {
   *   to: nftAddress,
   *   data: encodedCall
   * }
   *
   * const { waitForTxHash } = await smartAccount.sendTransaction(transaction);
   * const { transactionHash, userOperationReceipt } = await wait();
   * ```
   */
  async sendTransaction(
    manyOrOneTransactions: Transaction | Transaction[],
    buildUseropDto?: BuildUserOpOptions,
    sessionData?: GetSessionParams
  ): Promise<UserOpResponse> {
    let defaultedBuildUseropDto = { ...buildUseropDto } ?? {}
    if (this.sessionType && sessionData) {
      const store = this.sessionStorageClient ?? sessionData?.store;
      const getSessionParameters = await this.getSessionParams({ ...sessionData, store, txs: manyOrOneTransactions })
      defaultedBuildUseropDto = {
        ...defaultedBuildUseropDto,
        ...getSessionParameters
      }
    }

    const userOp = await this.buildUserOp(
      Array.isArray(manyOrOneTransactions)
        ? manyOrOneTransactions
        : [manyOrOneTransactions],
      defaultedBuildUseropDto
    )

    return this.sendUserOp(userOp, { ...defaultedBuildUseropDto?.params })
  }
  /**
   * Retrieves the session parameters for sending the session transaction
   * 
   * @description This method is called under the hood with the third argument passed into the smartAccount.sendTransaction(...args) method. It is used to retrieve the relevant session parameters while sending the session transaction.
   *
   * @param leafIndex - The leaf index(es) of the session in the storage client to be used. If you want to use the last leaf index, you can pass "LAST_LEAVES" as the value.
   * @param store - The {@link ISessionStorage} client to be used. If you want to use the default storage client (localStorage in the browser), you can pass "DEFAULT_STORE" as the value. Alternatively you can pass in {@link SessionSearchParam} for more control over how the leaves are stored and retrieved.
   * @param chain - Optional, will be inferred if left unset
   * @param txs - Optional, used only for validation while using Batched session type
   * @returns Promise<{@link GetSessionParams}> 
   *
   * @example
   * ```ts
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl }); // Retrieve bundler url from dashboard
   * const encodedCall = encodeFunctionData({
   *   abi: parseAbi(["function safeMint(address to) public"]),
   *   functionName: "safeMint",
   *   args: ["0x..."],
   * });
   *
   * const transaction = {
   *   to: nftAddress,
   *   data: encodedCall
   * }
   *
   * const { waitForTxHash } = await smartAccount.sendTransaction(transaction);
   * const { transactionHash, userOperationReceipt } = await wait();
   * ```
   */
  public async getSessionParams({
    leafIndex,
    store,
    chain,
    txs
  }: GetSessionParams): Promise<{ params: ModuleInfo }> {

    const accountAddress = await this.getAccountAddress()
    const defaultedTransactions: Transaction[] | null = txs
      ? Array.isArray(txs)
        ? [...txs]
        : [txs]
      : []

    const defaultedConditionalSession: SessionSearchParam = store === "DEFAULT_STORE" ? getDefaultStorageClient(accountAddress) :
      store ?? (await this.getAccountAddress())

    const defaultedCorrespondingIndexes: (number[] | null) = ["LAST_LEAF", "LAST_LEAVES"].includes(String(leafIndex)) ? null : leafIndex
      ? (Array.isArray(leafIndex)
        ? leafIndex
        : [leafIndex]) as number[]
      : null

    const correspondingIndex: number | null = defaultedCorrespondingIndexes
      ? defaultedCorrespondingIndexes[0]
      : null

    const defaultedChain: Chain =
      chain ?? getChain(await this.provider.getChainId())

    if (!defaultedChain) throw new Error("Chain is not provided")

    if (this.sessionType === "DISTRIBUTED_KEY") {
      return getDanSessionTxParams(
        defaultedConditionalSession,
        defaultedChain,
        correspondingIndex
      )
    }
    if (this.sessionType === "BATCHED") {
      return getBatchSessionTxParams(
        defaultedTransactions,
        defaultedCorrespondingIndexes,
        defaultedConditionalSession,
        defaultedChain
      )
    }
    if (this.sessionType === "STANDARD") {
      return getSingleSessionTxParams(
        defaultedConditionalSession,
        defaultedChain,
        correspondingIndex
      )
    }
    throw new Error("Session type is not provided")
  }

  /**
   * Builds a user operation
   *
   * This method will also simulate the validation and execution of the user operation, telling the user if the user operation will be successful or not.
   *
   * - Docs: https://docs.biconomy.io/Account/methods#builduserop-
   *
   * @param transactions Array of {@link Transaction} to be sent.
   * @param buildUseropDto {@link BuildUserOpOptions}.
   * @returns Promise<Partial{@link UserOperationStruct}>> the built user operation to be sent.
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({ signer, bundlerUrl }); // Retrieve bundler url from dashboard
   * const encodedCall = encodeFunctionData({
   *   abi: parseAbi(["function safeMint(address to) public"]),
   *   functionName: "safeMint",
   *   args: ["0x..."],
   * });
   *
   * const transaction = {
   *   to: nftAddress,
   *   data: encodedCall
   * }
   *
   * const userOp = await smartAccount.buildUserOp([{ to: "0x...", data: encodedCall }]);
   *
   */
  async buildUserOp(
    transactions: Transaction[],
    buildUseropDto?: BuildUserOpOptions,
  ): Promise<Partial<UserOperationStruct>> {
    const to = transactions.map((element: Transaction) => element.to as Hex);
    const data = transactions.map(
      (element: Transaction) => (element.data as Hex) ?? "0x",
    );
    const value = transactions.map(
      (element: Transaction) => (element.value as bigint) ?? BigInt(0),
    );

    const initCodeFetchPromise = this.getInitCode();
    const dummySignatureFetchPromise = this.getDummySignatures(
      buildUseropDto?.params,
    );

    const [nonceFromFetch, initCode, signature] = await Promise.all([
      this.getBuildUserOpNonce(buildUseropDto?.nonceOptions),
      initCodeFetchPromise,
      dummySignatureFetchPromise,
    ]);

    if (transactions.length === 0) {
      throw new Error("Transactions array cannot be empty");
    }
    let callData: Hex = "0x";
    if (!buildUseropDto?.useEmptyDeployCallData) {
      if (transactions.length > 1 || buildUseropDto?.forceEncodeForBatch) {
        callData = await this.encodeExecuteBatch(to, value, data);
      } else {
        // transactions.length must be 1
        callData = await this.encodeExecute(to[0], value[0], data[0]);
      }
    }

    let userOp: Partial<UserOperationStruct> = {
      sender: (await this.getAccountAddress()) as Hex,
      nonce: toHex(nonceFromFetch),
      initCode,
      callData,
    };

    // for this Smart Account current validation module dummy signature will be used to estimate gas
    userOp.signature = signature;
    userOp.paymasterAndData = buildUseropDto?.dummyPndOverride ?? "0x";

    if (
      buildUseropDto?.paymasterServiceData &&
      buildUseropDto?.paymasterServiceData.mode === PaymasterMode.SPONSORED &&
      this.paymaster instanceof BiconomyPaymaster
    ) {
      const gasFeeValues = await this.bundler?.getGasFeeValues();

      // populate gasfee values and make a call to paymaster
      userOp.maxFeePerGas = gasFeeValues?.maxFeePerGas as Hex;
      userOp.maxPriorityFeePerGas = gasFeeValues?.maxPriorityFeePerGas as Hex;

      if (buildUseropDto.gasOffset) {
        userOp = await this.estimateUserOpGas(userOp);

        const {
          verificationGasLimitOffsetPct,
          preVerificationGasOffsetPct,
          callGasLimitOffsetPct,
          maxFeePerGasOffsetPct,
          maxPriorityFeePerGasOffsetPct,
        } = buildUseropDto.gasOffset;
        userOp.verificationGasLimit = toHex(
          Number.parseInt(
            (
              Number(userOp.verificationGasLimit ?? 0) *
              convertToFactor(verificationGasLimitOffsetPct)
            ).toString(),
          ),
        );
        userOp.preVerificationGas = toHex(
          Number.parseInt(
            (
              Number(userOp.preVerificationGas ?? 0) *
              convertToFactor(preVerificationGasOffsetPct)
            ).toString(),
          ),
        );
        userOp.callGasLimit = toHex(
          Number.parseInt(
            (
              Number(userOp.callGasLimit ?? 0) *
              convertToFactor(callGasLimitOffsetPct)
            ).toString(),
          ),
        );
        userOp.maxFeePerGas = toHex(
          Number.parseInt(
            (
              Number(userOp.maxFeePerGas ?? 0) *
              convertToFactor(maxFeePerGasOffsetPct)
            ).toString(),
          ),
        );
        userOp.maxPriorityFeePerGas = toHex(
          Number.parseInt(
            (
              Number(userOp.maxPriorityFeePerGas ?? 0) *
              convertToFactor(maxPriorityFeePerGasOffsetPct)
            ).toString(),
          ),
        );

        userOp = await this.getPaymasterUserOp(userOp, {
          ...buildUseropDto.paymasterServiceData,
          calculateGasLimits: false,
        });
        return userOp;
      }
      if (buildUseropDto.paymasterServiceData.calculateGasLimits === false) {
        userOp = await this.estimateUserOpGas(userOp);
      }

      userOp = await this.getPaymasterUserOp(
        userOp,
        buildUseropDto.paymasterServiceData,
      );

      return userOp;
    }

    userOp = await this.estimateUserOpGas(userOp);

    if (buildUseropDto?.gasOffset) {
      if (buildUseropDto?.paymasterServiceData) {
        userOp = await this.getPaymasterUserOp(userOp, {
          ...buildUseropDto.paymasterServiceData,
          calculateGasLimits: false,
        });
      }

      const {
        verificationGasLimitOffsetPct,
        preVerificationGasOffsetPct,
        callGasLimitOffsetPct,
        maxFeePerGasOffsetPct,
        maxPriorityFeePerGasOffsetPct,
      } = buildUseropDto.gasOffset;
      userOp.verificationGasLimit = toHex(
        Number.parseInt(
          (
            Number(userOp.verificationGasLimit ?? 0) *
            convertToFactor(verificationGasLimitOffsetPct)
          ).toString(),
        ),
      );
      userOp.preVerificationGas = toHex(
        Number.parseInt(
          (
            Number(userOp.preVerificationGas ?? 0) *
            convertToFactor(preVerificationGasOffsetPct)
          ).toString(),
        ),
      );
      userOp.callGasLimit = toHex(
        Number.parseInt(
          (
            Number(userOp.callGasLimit ?? 0) *
            convertToFactor(callGasLimitOffsetPct)
          ).toString(),
        ),
      );
      userOp.maxFeePerGas = toHex(
        Number.parseInt(
          (
            Number(userOp.maxFeePerGas ?? 0) *
            convertToFactor(maxFeePerGasOffsetPct)
          ).toString(),
        ),
      );
      userOp.maxPriorityFeePerGas = toHex(
        Number.parseInt(
          (
            Number(userOp.maxPriorityFeePerGas ?? 0) *
            convertToFactor(maxPriorityFeePerGasOffsetPct)
          ).toString(),
        ),
      );

      return userOp;
    }
    if (buildUseropDto?.paymasterServiceData) {
      userOp = await this.getPaymasterUserOp(
        userOp,
        buildUseropDto.paymasterServiceData,
      );
    }
    return userOp;
  }

  private validateUserOpAndPaymasterRequest(
    userOp: Partial<UserOperationStruct>,
    tokenPaymasterRequest: BiconomyTokenPaymasterRequest,
  ): void {
    if (isNullOrUndefined(userOp.callData)) {
      throw new Error("UserOp callData cannot be undefined");
    }

    const feeTokenAddress = tokenPaymasterRequest?.feeQuote?.tokenAddress;
    Logger.warn("Requested fee token is ", feeTokenAddress);

    if (!feeTokenAddress || feeTokenAddress === ADDRESS_ZERO) {
      throw new Error(
        "Invalid or missing token address. Token address must be part of the feeQuote in tokenPaymasterRequest",
      );
    }

    const spender = tokenPaymasterRequest?.spender;
    Logger.warn("Spender address is ", spender);

    if (!spender || spender === ADDRESS_ZERO) {
      throw new Error(
        "Invalid or missing spender address. Sepnder address must be part of tokenPaymasterRequest",
      );
    }
  }

  /**
   *
   * @param userOp partial user operation without signature and paymasterAndData
   * @param tokenPaymasterRequest This dto provides information about fee quote. Fee quote is received from earlier request getFeeQuotesOrData() to the Biconomy paymaster.
   *  maxFee and token decimals from the quote, along with the spender is required to append approval transaction.
   * @notice This method should be called when gas is paid in ERC20 token using TokenPaymaster
   * @description Optional method to update the userOp.calldata with batched transaction which approves the paymaster spender with necessary amount(if required)
   * @returns updated userOp with new callData, callGasLimit
   */
  async buildTokenPaymasterUserOp(
    userOp: Partial<UserOperationStruct>,
    tokenPaymasterRequest: BiconomyTokenPaymasterRequest,
  ): Promise<Partial<UserOperationStruct>> {
    this.validateUserOpAndPaymasterRequest(userOp, tokenPaymasterRequest);
    try {
      let batchTo: Array<Hex> = [];
      let batchValue: Array<bigint> = [];
      let batchData: Array<Hex> = [];

      let newCallData = userOp.callData;
      Logger.warn(
        "Received information about fee token address and quote ",
        tokenPaymasterRequest.toString(),
      );

      if (this.paymaster && this.paymaster instanceof Paymaster) {
        // Make a call to paymaster.buildTokenApprovalTransaction() with necessary details

        // Review: might request this form of an array of Transaction
        const approvalRequest: Transaction = await (
          this.paymaster as IHybridPaymaster<SponsorUserOperationDto>
        ).buildTokenApprovalTransaction(tokenPaymasterRequest);
        Logger.warn("ApprovalRequest is for erc20 token ", approvalRequest.to);

        if (
          approvalRequest.data === "0x" ||
          approvalRequest.to === ADDRESS_ZERO
        ) {
          return userOp;
        }

        if (isNullOrUndefined(userOp.callData)) {
          throw new Error("UserOp callData cannot be undefined");
        }

        const decodedSmartAccountData = decodeFunctionData({
          abi: BiconomyAccountAbi,
          data: userOp.callData as Hex,
        });

        if (!decodedSmartAccountData) {
          throw new Error(
            "Could not parse userOp call data for this smart account",
          );
        }

        const smartAccountExecFunctionName =
          decodedSmartAccountData.functionName;

        Logger.warn(
          `Originally an ${smartAccountExecFunctionName} method call for Biconomy Account V2`,
        );
        if (
          smartAccountExecFunctionName === "execute" ||
          smartAccountExecFunctionName === "execute_ncC"
        ) {
          const methodArgsSmartWalletExecuteCall = decodedSmartAccountData.args;
          const toOriginal = methodArgsSmartWalletExecuteCall[0];
          const valueOriginal = methodArgsSmartWalletExecuteCall[1];
          const dataOriginal = methodArgsSmartWalletExecuteCall[2];

          batchTo.push(toOriginal);
          batchValue.push(valueOriginal);
          batchData.push(dataOriginal);
        } else if (
          smartAccountExecFunctionName === "executeBatch" ||
          smartAccountExecFunctionName === "executeBatch_y6U"
        ) {
          const methodArgsSmartWalletExecuteCall = decodedSmartAccountData.args;
          batchTo = [...methodArgsSmartWalletExecuteCall[0]];
          batchValue = [...methodArgsSmartWalletExecuteCall[1]];
          batchData = [...methodArgsSmartWalletExecuteCall[2]];
        }

        if (
          approvalRequest.to &&
          approvalRequest.data &&
          approvalRequest.value
        ) {
          batchTo = [approvalRequest.to as Hex, ...batchTo];
          batchValue = [
            BigInt(Number(approvalRequest.value.toString())),
            ...batchValue,
          ];
          batchData = [approvalRequest.data as Hex, ...batchData];

          newCallData = await this.encodeExecuteBatch(
            batchTo,
            batchValue,
            batchData,
          );
        }
        const finalUserOp: Partial<UserOperationStruct> = {
          ...userOp,
          callData: newCallData,
        };

        // Optionally Requesting to update gas limits again (especially callGasLimit needs to be re-calculated)

        return finalUserOp;
      }
    } catch (error) {
      Logger.log("Failed to update userOp. Sending back original op");
      Logger.error(
        "Failed to update callData with error",
        JSON.stringify(error),
      );
      return userOp;
    }
    return userOp;
  }

  async signUserOpHash(userOpHash: string, params?: ModuleInfo): Promise<Hex> {
    this.isActiveValidationModuleDefined();
    const moduleSig = (await this.activeValidationModule.signUserOpHash(
      userOpHash,
      params,
    )) as Hex;

    const signatureWithModuleAddress = encodeAbiParameters(
      parseAbiParameters("bytes, address"),
      [moduleSig, this.activeValidationModule.getAddress() as Hex],
    );

    return signatureWithModuleAddress;
  }

  /**
   * Deploys the smart contract
   *
   * This method will deploy a Smart Account contract. It is useful for deploying in a moment when you know that gas prices are low,
   * and you want to deploy the account before sending the first user operation. This step can otherwise be skipped,
   * as the deployment will alternatively be bundled with the first user operation.
   *
   * @param buildUseropDto {@link BuildUserOpOptions}.
   * @returns Promise<{@link UserOpResponse}> that you can use to track the user operation.
   * @error Throws an error if the account has already been deployed.
   * @error Throws an error if the account has not enough native token balance to deploy, if not using a paymaster.
   *
   * @example
   * import { createClient } from "viem"
   * import { createSmartAccountClient } from "@biconomy/account"
   * import { createWalletClient, http } from "viem";
   * import { polygonAmoy } from "viem/chains";
   *
   * const signer = createWalletClient({
   *   account,
   *   chain: polygonAmoy,
   *   transport: http(),
   * });
   *
   * const smartAccount = await createSmartAccountClient({
   *  signer,
   *  biconomyPaymasterApiKey,
   *  bundlerUrl
   * });
   *
   * // If you want to use a paymaster...
   * const { wait } = await smartAccount.deploy({
   *   paymasterServiceData: { mode: PaymasterMode.SPONSORED },
   * });
   *
   * // Or if you can't use a paymaster send native token to this address:
   * const counterfactualAddress = await smartAccount.getAccountAddress();
   *
   * // Then deploy the account
   * const { wait } = await smartAccount.deploy();
   *
   * const { success, receipt } = await wait();
   *
   */
  public async deploy(
    buildUseropDto?: BuildUserOpOptions,
  ): Promise<UserOpResponse> {
    const accountAddress =
      this.accountAddress ?? (await this.getAccountAddress());

    // Check that the account has not already been deployed
    const byteCode = await this.provider?.getBytecode({
      address: accountAddress as Hex,
    });
    if (byteCode !== undefined) {
      throw new Error(ERROR_MESSAGES.ACCOUNT_ALREADY_DEPLOYED);
    }

    // Check that the account has enough native token balance to deploy, if not using a paymaster
    if (!buildUseropDto?.paymasterServiceData?.mode) {
      const nativeTokenBalance = await this.provider?.getBalance({
        address: accountAddress,
      });
      if (nativeTokenBalance === BigInt(0)) {
        throw new Error(ERROR_MESSAGES.NO_NATIVE_TOKEN_BALANCE_DURING_DEPLOY);
      }
    }

    const useEmptyDeployCallData = true;

    return this.sendTransaction(
      {
        to: accountAddress,
        data: "0x",
      },
      { ...buildUseropDto, useEmptyDeployCallData },
    );
  }

  async getFactoryData() {
    if (await this.isAccountDeployed()) return undefined;

    this.isDefaultValidationModuleDefined();

    return encodeFunctionData({
      abi: BiconomyFactoryAbi,
      functionName: "deployCounterFactualAccount",
      args: [
        this.defaultValidationModule.getAddress() as Hex,
        (await this.defaultValidationModule.getInitData()) as Hex,
        BigInt(this.index),
      ],
    });
  }

  async signMessage(message: string | Uint8Array): Promise<Hex> {
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    let signature: any
    this.isActiveValidationModuleDefined()
    const dataHash = typeof message === "string" ? toBytes(message) : message
    signature = await this.activeValidationModule.signMessage(dataHash)

    const potentiallyIncorrectV = Number.parseInt(signature.slice(-2), 16);
    if (![27, 28].includes(potentiallyIncorrectV)) {
      const correctV = potentiallyIncorrectV + 27;
      signature = signature.slice(0, -2) + correctV.toString(16);
    }
    if (signature.slice(0, 2) !== "0x") {
      signature = `0x${signature}`;
    }
    signature = encodeAbiParameters(
      [{ type: "bytes" }, { type: "address" }],
      [signature as Hex, this.defaultValidationModule.getAddress()],
    );
    if (await this.isAccountDeployed()) {
      return signature as Hex;
    }
    const abiEncodedMessage = encodeAbiParameters(
      [
        {
          type: "address",
          name: "create2Factory",
        },
        {
          type: "bytes",
          name: "factoryCalldata",
        },
        {
          type: "bytes",
          name: "originalERC1271Signature",
        },
      ],
      [
        this.getFactoryAddress() ?? "0x",
        (await this.getFactoryData()) ?? "0x",
        signature,
      ],
    );
    return concat([abiEncodedMessage, MAGIC_BYTES]);
  }

  async getIsValidSignatureData(
    messageHash: Hex,
    signature: Hex,
  ): Promise<Hex> {
    return encodeFunctionData({
      abi: BiconomyAccountAbi,
      functionName: "isValidSignature",
      args: [messageHash, signature],
    });
  }

  async enableModule(moduleAddress: Hex): Promise<UserOpResponse> {
    const tx: Transaction = await this.getEnableModuleData(moduleAddress);
    const partialUserOp = await this.buildUserOp([tx]);
    return this.sendUserOp(partialUserOp);
  }

  async getEnableModuleData(moduleAddress: Hex): Promise<Transaction> {
    const callData = encodeFunctionData({
      abi: BiconomyAccountAbi,
      functionName: "enableModule",
      args: [moduleAddress],
    });
    const tx: Transaction = {
      to: await this.getAddress(),
      value: "0x00",
      data: callData,
    };
    return tx;
  }

  async getSetupAndEnableModuleData(
    moduleAddress: Hex,
    moduleSetupData: Hex,
  ): Promise<Transaction> {
    const callData = encodeFunctionData({
      abi: BiconomyAccountAbi,
      functionName: "setupAndEnableModule",
      args: [moduleAddress, moduleSetupData],
    });
    const tx: Transaction = {
      to: await this.getAddress(),
      value: "0x00",
      data: callData,
    };
    return tx;
  }

  async disableModule(
    prevModule: Hex,
    moduleAddress: Hex,
  ): Promise<UserOpResponse> {
    const tx: Transaction = await this.getDisableModuleData(
      prevModule,
      moduleAddress,
    );
    const partialUserOp = await this.buildUserOp([tx]);
    return this.sendUserOp(partialUserOp);
  }

  async getDisableModuleData(
    prevModule: Hex,
    moduleAddress: Hex,
  ): Promise<Transaction> {
    const callData = encodeFunctionData({
      abi: BiconomyAccountAbi,
      functionName: "disableModule",
      args: [prevModule, moduleAddress],
    });
    const tx: Transaction = {
      to: await this.getAddress(),
      value: "0x00",
      data: callData,
    };
    return tx;
  }

  async isModuleEnabled(moduleAddress: Hex): Promise<boolean> {
    const accountContract = await this._getAccountContract();
    return accountContract.read.isModuleEnabled([moduleAddress]);
  }

  // Review
  async getAllModules(pageSize?: number): Promise<Array<string>> {
    const _pageSize = pageSize ?? 100;
    const accountContract = await this._getAccountContract();
    const result = await accountContract.read.getModulesPaginated([
      this.SENTINEL_MODULE as Hex,
      BigInt(_pageSize),
    ]);
    const modules: Array<string> = result[0] as Array<string>;
    return modules;
  }
}