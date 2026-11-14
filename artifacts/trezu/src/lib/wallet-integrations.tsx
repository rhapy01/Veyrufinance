import { createContext, type ReactNode, useCallback, useContext, useRef } from "react";
import { PrivyProvider, usePrivy, useToken, useWallets } from "@privy-io/react-auth";
import { FastAuthProvider, useFastAuth, usePublicKey, useSigner } from "@fast-auth-near/react-sdk";
import { JavascriptProvider } from "@fast-auth-near/javascript-provider";
import { linkEvmWalletToTrezu, sendBaseSepoliaContractCall, sendQuotedDeposit, waitForEvmTransaction, type EvmWalletProvider, type WalletAsset } from "./evm-wallet";

const env = import.meta.env as Record<string, string | undefined>;
const privyAppId = env.VITE_PRIVY_APP_ID?.trim() || "";
// This build is deliberately testnet-only. Keep Auth, RPC, Wallet Selector,
// and transaction signing on the same NEAR network.
const nearNetwork = "testnet" as const;
// NEAR Auth publishes this shared Auth0 client for testnet development. Never
// fall back to it in a production build or when mainnet has been selected.
const nearTestnetClientId = "np8paqIpMWmNbzT4xAvOOapZBjsOpptl";
const nearClientId = env.VITE_NEAR_AUTH_CLIENT_ID?.trim()
  || (import.meta.env.DEV ? nearTestnetClientId : "");
const nearProvider = nearClientId ? new JavascriptProvider({
  network: nearNetwork,
  clientId: nearClientId,
  ...(env.VITE_NEAR_AUTH_DOMAIN ? { domain: env.VITE_NEAR_AUTH_DOMAIN } : {}),
  ...(env.VITE_NEAR_AUTH_SIGNING_AUDIENCE ? { signingAudience: env.VITE_NEAR_AUTH_SIGNING_AUDIENCE } : {}),
}) : null;
const nearConnection = { networkId: "testnet", provider: { type: "JsonRpcProvider", args: { url: "https://rpc.testnet.near.org" } } } as never;

type WalletContext = {
  privyEnabled: boolean; privyReady: boolean; privyAuthenticated: boolean; privyAddress: string; privyError: string;
  privyLogin: () => Promise<string>; privyLogout: () => void; privyAccessToken: string; privyGetAccessToken: () => Promise<string | null>;
  linkPrivyWallet: () => Promise<{ address: string; network: string }>;
  sendPrivyDeposit: (asset: WalletAsset, depositAddress: string, amountIn: string) => Promise<string>;
  sendPrivyContractCall: (contract: string, data: string) => Promise<string>;
  waitForPrivyTransaction: (hash: string) => Promise<void>;
};
const PrivyContext = createContext<WalletContext>({ privyEnabled: false, privyReady: false, privyAuthenticated: false, privyAddress: "", privyError: "", privyLogin: async () => { throw new Error("Privy is not configured."); }, privyLogout: () => {}, privyAccessToken: "", privyGetAccessToken: async () => null, linkPrivyWallet: async () => { throw new Error("Privy is not configured."); }, sendPrivyDeposit: async () => { throw new Error("Privy is not configured."); }, sendPrivyContractCall: async () => { throw new Error("Privy is not configured."); }, waitForPrivyTransaction: async () => { throw new Error("Privy is not configured."); } });
export const usePrivyWallet = () => useContext(PrivyContext);

function PrivyBridge({ children }: { children: ReactNode }) {
 const privy=usePrivy(); const {wallets}=useWallets(); const {getAccessToken}=useToken(); const walletsRef=useRef(wallets); walletsRef.current=wallets; const accessTokenRef=useRef<string|null>(null); const wallet=wallets.find((w)=>w.walletClientType==="privy");
 const accessTokenRequest=useRef<Promise<string|null>|null>(null);
 const linkPrivyWallet=async()=>{let activeWallet=walletsRef.current.find((w)=>w.walletClientType==="privy");for(let attempt=0;attempt<40&&!activeWallet;attempt++){await new Promise((resolve)=>setTimeout(resolve,100));activeWallet=walletsRef.current.find((w)=>w.walletClientType==="privy");}if(!activeWallet)throw new Error("Privy has not finished initializing the embedded wallet. Sign in to Privy and wait for the wallet to appear.");return linkEvmWalletToTrezu(await activeWallet.getEthereumProvider());};
 const privyGetAccessToken=useCallback(()=>{if(accessTokenRequest.current)return accessTokenRequest.current;const request=getAccessToken().then((token)=>{accessTokenRef.current=token;return token;}).finally(()=>{if(accessTokenRequest.current===request)accessTokenRequest.current=null;});accessTokenRequest.current=request;return request;},[getAccessToken]);
 const privyLogin=async()=>{if(!privy.authenticated)await privy.login();for(let attempt=0;attempt<12;attempt++){const token=accessTokenRef.current||await privyGetAccessToken();if(token)return token;await new Promise((resolve)=>setTimeout(resolve,250));}throw new Error("Privy completed sign-in, but the session token is still being issued. Please try Continue with Privy again.");};
 return <PrivyContext.Provider value={{privyEnabled:true,privyReady:privy.ready,privyAuthenticated:privy.authenticated,privyAddress:wallet?.address||"",privyError:privy.error?.message||"",privyLogin,privyLogout:()=>{accessTokenRef.current=null;void privy.logout();},privyAccessToken:accessTokenRef.current||"",privyGetAccessToken,linkPrivyWallet,sendPrivyDeposit:async(asset,to,amount)=>{if(!wallet)throw new Error("Your Privy wallet is still being created.");return sendQuotedDeposit(asset,to,amount,await wallet.getEthereumProvider());},sendPrivyContractCall:async(contract,data)=>{if(!wallet)throw new Error("Your Privy wallet is still being created.");return sendBaseSepoliaContractCall(await wallet.getEthereumProvider() as EvmWalletProvider,contract,data);},waitForPrivyTransaction:async(hash)=>{if(!wallet)throw new Error("Your Privy wallet is still being created.");return waitForEvmTransaction(await wallet.getEthereumProvider() as EvmWalletProvider,hash);}}}>{children}</PrivyContext.Provider>;
}

type NearAuthContext = { enabled: boolean; network: "mainnet" | "testnet"; ready: boolean; loggedIn: boolean; publicKey: string; login: () => void; logout: () => void; createAccount: (accountId: string) => Promise<string> };
const NearContext = createContext<NearAuthContext>({ enabled: false, network: nearNetwork, ready: false, loggedIn: false, publicKey: "", login: () => {}, logout: () => {}, createAccount: async () => { throw new Error("NEAR Auth is not configured."); } });
export const useNearAuth = () => useContext(NearContext);

function NearAuthBridge({ children }: { children: ReactNode }) {
 const {client,isReady}=useFastAuth();const {publicKey}=usePublicKey("ed25519",true);const {signer}=useSigner(true);
 return <NearContext.Provider value={{enabled:true,network:nearNetwork,ready:isReady,loggedIn:Boolean(publicKey),publicKey:publicKey?.toString()||"",login:()=>{void client?.login();},logout:()=>{void client?.logout();},createAccount:async(accountId)=>{if(!signer)throw new Error("Sign in with NEAR Auth first.");if(!/^[a-z0-9._-]{2,64}$/.test(accountId))throw new Error("Enter a valid NEAR account name.");return signer.createAccount(accountId);}}}>{children}</NearContext.Provider>;
}

function WithNearAuth({ children }: { children: ReactNode }) {
  if(!nearProvider)return <>{children}</>;
  return <FastAuthProvider providerConfig={{provider:nearProvider}} connection={nearConnection} network="testnet"><NearAuthBridge>{children}</NearAuthBridge></FastAuthProvider>;
}

export function WalletIntegrations({ children }: { children: ReactNode }) {
  const near=<WithNearAuth>{children}</WithNearAuth>;
  if(!privyAppId)return near;
  return <PrivyProvider appId={privyAppId} config={{
    // The configured Privy app currently enables email login only. Requesting
    // Google/Apple here advertises methods the app has not enabled.
    loginMethods: ["email"],
    embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
  }}><PrivyBridge>{near}</PrivyBridge></PrivyProvider>;
}
