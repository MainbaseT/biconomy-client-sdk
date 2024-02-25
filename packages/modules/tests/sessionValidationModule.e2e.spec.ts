import { DEFAULT_SESSION_KEY_MANAGER_MODULE, createSessionKeyManagerModule } from "@biconomy/modules";
import { SessionFileStorage } from "./utils/customSession";
import { WalletClientSigner, createSmartAccountClient } from "../../account/src/index";
import { Hex, encodeAbiParameters, encodeFunctionData, parseAbi, parseUnits } from "viem";
import { TestData } from "../../../tests";
import { checkBalance } from "../../../tests/utils";
import { PaymasterMode } from "@biconomy/paymaster";

describe("Session Validation Module Tests", () => {
  let mumbai: TestData;

  beforeEach(() => {
    // @ts-ignore: Comes from setup-e2e-tests
    [mumbai] = testDataPerChain;
  });

  it("Should send a user op using Session Validation Module", async () => {
    let sessionSigner: WalletClientSigner;

    const {
      whale: {
        account: { address: sessionKeyEOA },
        privateKey: pvKey,
        viemWallet,
      },
      minnow: { publicAddress: recipient },
      publicClient,
      chainId,
      bundlerUrl,
      biconomyPaymasterApiKey,
    } = mumbai;

    // Create smart account
    let smartAccount = await createSmartAccountClient({
      chainId,
      signer: viemWallet,
      bundlerUrl,
      biconomyPaymasterApiKey,
      index: 1, // Increasing index to not conflict with other test cases and use a new smart account
    });

    const sessionFileStorage: SessionFileStorage = new SessionFileStorage(await smartAccount.getAccountAddress());

    try {
      sessionSigner = await sessionFileStorage.getSignerByKey(sessionKeyEOA);
    } catch (error) {
      sessionSigner = await sessionFileStorage.addSigner({ pbKey: sessionKeyEOA, pvKey });
    }

    expect(sessionSigner).toBeTruthy();

    // Create session module
    const sessionModule = await createSessionKeyManagerModule({
      moduleAddress: DEFAULT_SESSION_KEY_MANAGER_MODULE,
      smartAccountAddress: await smartAccount.getAddress(),
      sessionStorageClient: sessionFileStorage,
    });

    // Set enabled call on session
    const sessionKeyData = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [
        sessionKeyEOA,
        "0xdA5289fCAAF71d52a80A254da614a192b693e977", // erc20 token address
        recipient, // receiver address
        parseUnits("10", 6),
      ],
    );

    const erc20ModuleAddr = "0x000000D50C68705bd6897B2d17c7de32FB519fDA";

    const sessionTxData = await sessionModule.createSessionData([
      {
        validUntil: 0,
        validAfter: 0,
        sessionValidationModule: erc20ModuleAddr,
        sessionPublicKey: sessionKeyEOA,
        sessionKeyData: sessionKeyData,
      },
    ]);

    const setSessionAllowedTrx = {
      to: DEFAULT_SESSION_KEY_MANAGER_MODULE,
      data: sessionTxData.data,
    };

    const txArray: any = [];

    // Check if module is enabled

    const isEnabled = await smartAccount.isModuleEnabled(DEFAULT_SESSION_KEY_MANAGER_MODULE);
    if (!isEnabled) {
      const enableModuleTrx = await smartAccount.getEnableModuleData(DEFAULT_SESSION_KEY_MANAGER_MODULE);
      txArray.push(enableModuleTrx);
      txArray.push(setSessionAllowedTrx);
    } else {
      console.log("MODULE ALREADY ENABLED");
      txArray.push(setSessionAllowedTrx);
    }

    const userOp = await smartAccount.buildUserOp(txArray);

    const userOpResponse1 = await smartAccount.sendUserOp(userOp);
    const transactionDetails = await userOpResponse1.wait();
    console.log("Tx Hash: ", transactionDetails.receipt.transactionHash);

    const encodedCall = encodeFunctionData({
      abi: parseAbi(["function transfer(address _to, uint256 _value)"]),
      functionName: "transfer",
      args: [recipient, parseUnits("0.01", 6)],
    });

    const transferTx = {
      to: "0xdA5289fCAAF71d52a80A254da614a192b693e977", //erc20 token address
      data: encodedCall,
    };

    smartAccount = smartAccount.setActiveValidationModule(sessionModule);

    const maticBalanceBefore = await checkBalance(publicClient, await smartAccount.getAccountAddress());

    const transferUserOp = await smartAccount.buildUserOp([transferTx], {
      params: {
        sessionSigner: sessionSigner,
        sessionValidationModule: erc20ModuleAddr.toLowerCase() as Hex,
      },
      paymasterServiceData: {
        mode: PaymasterMode.SPONSORED,
      },
    });

    expect(transferUserOp.paymasterAndData).toBeDefined();
    expect(transferUserOp.paymasterAndData).not.toBeNull();
    expect(transferUserOp.paymasterAndData).not.toBe("0x");

    const userOpResponse2 = await smartAccount.sendTransaction(transferTx, {
      params: {
        sessionSigner: sessionSigner,
        sessionValidationModule: erc20ModuleAddr.toLowerCase() as Hex,
      },
      paymasterServiceData: {
        mode: PaymasterMode.SPONSORED,
      },
    });

    expect(userOpResponse2.userOpHash).toBeTruthy();
    expect(userOpResponse2.userOpHash).not.toBeNull();

    const maticBalanceAfter = await checkBalance(publicClient, await smartAccount.getAccountAddress());

    expect(maticBalanceAfter).toEqual(maticBalanceBefore);

    console.log(`Tx at: https://jiffyscan.xyz/userOpHash/${userOpResponse2.userOpHash}?network=mumbai`);
  }, 60000);
});
