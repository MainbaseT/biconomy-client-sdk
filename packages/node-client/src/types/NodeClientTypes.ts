export type SmartAccountInfoResponse = {
  readonly name: string
  readonly version: string
  readonly api_version: string
  readonly secure: boolean
  readonly settings: {
    readonly AWS_CONFIGURED: boolean
    readonly AWS_S3_CUSTOM_DOMAIN: string
    readonly ETHEREUM_NODE_URL: string
    readonly ETHEREUM_TRACING_NODE_URL: string
    readonly ETH_INTERNAL_TXS_BLOCK_PROCESS_LIMIT: number
    readonly ETH_INTERNAL_NO_FILTER: boolean
    readonly ETH_REORG_BLOCKS: number
    readonly TOKENS_LOGO_BASE_URI: string
    readonly TOKENS_LOGO_EXTENSION: string
  }
}

export type BalancesDto = {
  chainId: number
  eoaAddress: string
  tokenAddresses: string[]
}

export type ChainConfig = {
  chainId: number
  name: string
  symbol: string
  isL2: boolean
  isMainnet: boolean
  description: string
  blockExplorerUriTemplate: BlockExplorerConfig
  ensRegistryAddress: string
  walletFactoryAddress: string
  multiSendAddress: string
  multiSendCallAddress: string
  walletAddress: string // base wallet
  entryPoint: string //should make this address var
  fallBackHandler: string //should make this address var
  relayerURL: string
  providerUrl: string
  indexerUrl: string
  backendNodeUrl: string
  createdAt: Date
  updatedAt: Date
  token: TokenInfo
}

export type MasterCopyResponse = {
  address: string
  version: string
  deployer: string
  deployedBlockNumber: number
  lastIndexedBlockNumber: number
}

export type SafeInfoResponse = {
  readonly address: string
  readonly nonce: number
  readonly threshold: number
  readonly owners: string[]
  readonly masterCopy: string
  readonly modules: string[]
  readonly fallbackHandler: string
  readonly version: string
}

export type OwnerResponse = {
  safes: string[]
}

export type BlockExplorerConfig = {
  address: string
  txHash: string
  api: string
}

export type TokenInfo = {
  id: number
  name: string
  symbol: string
  blockChain: number
  ercType?: string
  decimals: number
  logoUri: string
  address: string
  isNativeToken: boolean
  isEnabled: boolean
  cmcId: number //Verify
  price: number //Verify
  createdAt: Date
  updatedAt: Date
}

export type ISmartAccount = {
  smartAccountAddress: string
  isDeployed: boolean
}

export type IBalances = {
  contract_decimals: number
  contract_name: string
  contract_ticker_symbol: string
  contract_address: string
  supports_erc: string | null
  logo_url: string | null
  last_transferred_at: string | null
  type: string
  balance: number
  balance_24h: number
  quote_rate: number
  quote_rate_24h: number
  nft_data: string | null
}

export type SupportedChainsResponse = {
  message: string
  code: number
  data: ChainConfig[]
}

export type individualChainResponse = {
  message: string
  code: number
  data: ChainConfig
}

export type TokenPriceResponse = {
  price: number
}

export type SupportedTokensResponse = {
  message: string
  code: number
  data: TokenInfo[]
}

export type IndividualTokenResponse = {
  message: string
  code: number
  data: TokenInfo
}
export type SmartAccountsResponse = {
  message: string
  code: number
  data: ISmartAccount
}
export type BalancesResponse = {
  message: string
  code: number
  data: IBalances[]
}

export type UsdBalanceResponse = {
  message: string
  code: number
  data: {
    totalBalance: number
  }
}