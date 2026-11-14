import { useEffect, useMemo, useRef, useState, useContext, createContext, useCallback, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { setAuthTokenGetter, setWorkspaceIdGetter } from '@workspace/api-client-react';
import {
  ArrowDownRight, ArrowLeftRight, ArrowRight, ArrowUpRight, BadgeCheck, BriefcaseBusiness,
  Check, ChevronDown, CircleHelp, Coins, Copy, FilePlus2, FileText, Globe2, Layers3,
  LockKeyhole, Menu, Plus, RefreshCw, Search, Send, ShieldCheck, SlidersHorizontal,
  Download, ExternalLink, Upload, Users, Wallet, X, Trash2,
} from 'lucide-react';
import {
  getGetAllocationsQueryKey, getGetDashboardQueryKey, getGetEmployeesQueryKey,
  getGetInvoicesQueryKey, getGetProfileQueryKey, getGetRecordsQueryKey,
  getGetVendorsQueryKey, useCreateVendorApplication, useListWorkspaces,
  useCreateWorkspace, useGetAllocations, useGetDashboard, useGetEmployees, useGetInvoices,
  useGetProfile, useGetRecords, useGetVendors, useUpdateAllocations,
} from '@workspace/api-client-react';
import type { AllocationsInput, InvoiceInput, VendorApplicationInput } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';
import { apiFetch, clearAuthTokens, getAccessToken, setAccessToken } from '@/lib/api-fetch';
import { connectNearWallet, getEvmChainId, getEvmWallet, resolveNearOwnerTestnetAccount, sendNearDeposit, sendNearDepositsBatch, sendQuotedDeposit } from '@/lib/evm-wallet';
import PublicInvoicePage from '@/pages/public-invoice';
import GuestInvoicePage from '@/pages/guest-invoice';
import { WalletIntegrations, usePrivyWallet } from '@/lib/wallet-integrations';
import { linkEvmWalletToTrezu } from '@/lib/evm-wallet';
import Privy, { LocalStorage } from '@privy-io/js-sdk-core';
import { initSigningPage, type SignPageSession } from '@peerfolio/privy-near-connect/sign-page';
import { AAVE_BASE_SEPOLIA, aaveSupplyCall, approveUsdcCall } from '@/lib/aave-base-sepolia';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
function postSignInPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  return next?.startsWith('/app') ? next : '/app';
}
const signPagePrivyAppId = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined)?.trim() || '';
const signPagePrivy = signPagePrivyAppId ? new Privy({ appId: signPagePrivyAppId, storage: new LocalStorage() }) : null;

// Tell the API client to always attach the stored JWT as Bearer token
setAuthTokenGetter(getAccessToken);
setWorkspaceIdGetter(() => typeof window !== 'undefined' ? localStorage.getItem('trezu_active_workspace_id') : null);

// ─── Auth context ──────────────────────────────────────────────────────────
const API_BASE = '/api';
const FREELANCER_TOUR_SESSION_KEY = 'trezu_freelancer_tour_step';
const FREELANCER_TOUR_DONE_KEY = 'trezu_freelancer_tour_completed';
function requestFreelancerTour() { window.dispatchEvent(new Event('trezu:freelancer-tour-start')); }

type FreelancerTourStep = { route: string; target: string; title: string; text: string; next: string; action?: 'open-invoice' | 'close-invoice' | 'open-invoice-and-finish' };
const freelancerTourSteps: FreelancerTourStep[] = [
  { route: '/app', target: '.overview-welcome', title: 'Your financial home', text: 'This is your overview. We will walk through how to record client work, prepare a payment link, and check settlement.', next: 'Show me invoices' },
  { route: '/app/invoices', target: '[data-testid="button-new-invoice"]', title: 'Start with an invoice', text: 'Add the work, amount, settlement asset, and your receiving address. Then send it to the recipient’s registered Veyra email.', next: 'Open the invoice form', action: 'open-invoice' },
  { route: '/app/invoices', target: '.modal-card', title: 'Add your work and receiving details', text: 'Enter the client and line items, then choose your testnet settlement asset and receiving wallet address. One submit creates both the invoice and checkout link; it does not email the client or move funds.', next: 'Show me payment records', action: 'close-invoice' },
  { route: '/app/records', target: '.page-heading', title: 'Follow what actually happened', text: 'Records show what Veyra has saved. An invoice only becomes paid after the payment provider confirms settlement. Quotes and drafts are not payments.', next: 'Back to my first invoice' },
  { route: '/app/invoices', target: '[data-testid="button-new-invoice"]', title: 'You are ready to begin', text: 'Create your first invoice whenever you are ready. Your client payment flow uses testnet tokens in this build; nothing moves without a wallet approval.', next: 'Start my first invoice', action: 'open-invoice-and-finish' },
];

interface AuthUser { id: string; email: string; name: string; role: string; }
interface AuthCtx {
  user: AuthUser | null;
  isLoaded: boolean;
  authError: string;
  walletProvisioningError: string;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name: string) => Promise<{ verificationUrl?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthCtx>({
  user: null, isLoaded: false, authError: '', walletProvisioningError: '',
  signIn: async () => {}, signUp: async () => ({}), signOut: async () => {},
});

function AuthProvider({ children }: { children: ReactNode }) {
  const privy = usePrivyWallet();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [authError, setAuthError] = useState('');
  const [walletProvisioningError, setWalletProvisioningError] = useState('');
  const pendingName = useRef('');
  const syncedPrivyAccessToken = useRef('');
  const interactivePrivyLogin = useRef(false);
  const syncing = useRef<{ privyAccessToken: string; promise: Promise<void> } | null>(null);

  useEffect(() => {
    if (!privy.privyEnabled || privy.privyReady) return;
    const timeout = window.setTimeout(() => {
      setAuthError('Privy is taking too long to restore your sign-in. Please continue with Privy again.');
      setIsLoaded(true);
    }, 15000);
    return () => window.clearTimeout(timeout);
  }, [privy.privyEnabled, privy.privyReady]);

  const syncPrivySession = useCallback((privyAccessToken: string, name = '') => {
    if (syncedPrivyAccessToken.current === privyAccessToken) { setIsLoaded(true); return Promise.resolve(); }
    if (syncing.current?.privyAccessToken === privyAccessToken) return syncing.current.promise;
    const promise = fetch(`${API_BASE}/auth/privy/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ privyAccessToken, name: name || pendingName.current }),
    }).then(async (res) => {
      let data: { accessToken?: string; user?: AuthUser; error?: string; walletProvisioning?: { near?: string; message?: string } } = {};
      try { data = await res.json(); } catch { /* handled as a server response error below */ }
      if (!res.ok || !data.accessToken || !data.user) throw new Error(data.error || 'Could not open your Veyra account with Privy.');
      setAccessToken(data.accessToken); setUser(data.user); setAuthError(''); setIsLoaded(true);
      setWalletProvisioningError(data.walletProvisioning?.near === 'pending' ? data.walletProvisioning.message || 'Privy has not finished provisioning the NEAR wallet.' : '');
      syncedPrivyAccessToken.current = privyAccessToken; pendingName.current = '';
    }).finally(() => { if (syncing.current?.promise === promise) syncing.current = null; });
    syncing.current = { privyAccessToken, promise };
    return promise;
  }, []);

  // Privy is the identity provider. A verified Privy identity is exchanged for
  // the short lived Veyra API session so the existing workspace APIs can keep
  // enforcing their own user and workspace permissions.
  useEffect(() => {
    if (!privy.privyEnabled) { setIsLoaded(true); return undefined; }
    if (!privy.privyReady) return undefined;
    if (privy.privyAuthenticated) {
      setIsLoaded(false);
      if (!privy.privyAccessToken && interactivePrivyLogin.current) return undefined;
      let cancelled = false;
      const timeout = window.setTimeout(() => {
        if (cancelled) return;
        setAuthError('Your Veyra session is taking too long to restore. Continue with Privy again to reopen your workspace.');
        setIsLoaded(true);
      }, 20000);
      void (async () => {
        try {
          let privyAccessToken = privy.privyAccessToken || await privy.privyGetAccessToken();
          // Privy's authenticated state can update just before its identity
          // token is available. Give that token exchange a moment to finish.
          for (let attempt = 0; !privyAccessToken && attempt < 12; attempt += 1) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            if (cancelled) return;
            privyAccessToken = await privy.privyGetAccessToken();
          }
          if (!privyAccessToken) throw new Error('Privy completed sign-in, but the session token is still being issued. Please try Continue with Privy again.');
          await syncPrivySession(privyAccessToken);
        } catch (error) {
          if (cancelled) return;
          clearAuthTokens(); setUser(null); setAuthError(error instanceof Error ? error.message : 'Could not connect to your Veyra account.'); setIsLoaded(true);
          console.error('Privy session sync failed:', error);
        }
      })();
      return () => { cancelled = true; window.clearTimeout(timeout); };
    }
    clearAuthTokens(); setUser(null); setAuthError(''); setIsLoaded(true);
    return undefined;
  }, [privy.privyEnabled, privy.privyReady, privy.privyAuthenticated, privy.privyAccessToken, privy.privyGetAccessToken, syncPrivySession]);

  const signIn = useCallback(async (_email: string, _password: string) => {
    if (!privy.privyEnabled) throw new Error('Privy authentication is not configured for this app.');
    interactivePrivyLogin.current = true;
    try { const accessToken = await privy.privyLogin(); await syncPrivySession(accessToken); }
    finally { interactivePrivyLogin.current = false; }
  }, [privy.privyEnabled, privy.privyLogin, syncPrivySession]);

  const signUp = useCallback(async (email: string, password: string, name: string) => {
    void email; void password;
    if (!privy.privyEnabled) throw new Error('Privy authentication is not configured for this app.');
    pendingName.current = name.trim();
    interactivePrivyLogin.current = true;
    try { const accessToken = await privy.privyLogin(); await syncPrivySession(accessToken, name.trim()); }
    finally { interactivePrivyLogin.current = false; }
    return {};
  }, [privy.privyEnabled, privy.privyLogin, syncPrivySession]);

  const signOut = useCallback(async () => {
    await apiFetch(`${API_BASE}/auth/logout`, { method: 'POST' }).catch(() => {});
    if (privy.privyAuthenticated) privy.privyLogout();
    clearAuthTokens();
    setUser(null);
    setWalletProvisioningError('');
    setAuthError('');
    queryClient.clear();
  }, [privy.privyAuthenticated, privy.privyLogout]);

  return <AuthContext.Provider value={{ user, isLoaded, authError, walletProvisioningError, signIn, signUp, signOut }}>{children}</AuthContext.Provider>;
}

function useAuth() { return useContext(AuthContext); }
type PayrollCycleSummary = {
  id: string;
  createdAt?: string;
  frequency: 'weekly' | 'biweekly' | 'monthly';
  periodStart: string;
  periodEnd: string;
  paymentDate: string;
  status: string;
  totals: Record<string, string>;
  items: { id: string; amount: string; currency: string; payoutAmount: string | null; payoutUsdPrice: string | null; status: string; stablecoin: string; network: string; walletAddress: string | null; providerReference: string | null; failureReason: string | null; employeeName: string; employeeEmail: string; depositTxHash?: string | null; paymentQuote: { paymentId: string; providerStatus: string; reconciliationStatus: string | null; quote: Record<string, unknown> | null; statusCheckedAt: string | null; originAssetSymbol: string | null; originAssetNetwork: string | null } | null }[];
};
type PayrollAsset = { assetId: string; decimals: number; blockchain: string; symbol: string; price?: number; priceUpdatedAt?: string; contractAddress?: string | null };
function payrollQuoteDetails(payload: Record<string, unknown> | null | undefined) {
  return payload?.quote && typeof payload.quote === 'object' ? payload.quote as Record<string, unknown> : {};
}
type TaxReserveReport = {
  from: string;
  to: string;
  basis: 'confirmed_internal_ledger_entries';
  taxAdvice: false;
  movementStatus: 'internal_ledger_only';
  totals: { currency: string; openingBalance: string; allocatedDuringPeriod: string; closingBalance: string }[];
  entries: { allocationId: string; paymentId: string; invoiceNumber: string; recordedAt: string; currency: string; sourceAmount: string; taxPercent: number; taxReserveAmount: string; internalOnly: true }[];
};
type InternalIncomeAutomation = { enabled: boolean; updatedAt: string | null; movementStatus: 'internal_ledger_only' };

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}




function Brand({ light = false }: { light?: boolean }) {
  return <Link href="/" className={`brand ${light ? 'brand-light' : ''}`} data-testid="link-brand">
    <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
    <span>Veyra</span>
  </Link>;
}

function HomePage() {
  const { user } = useAuth();
  return <main className="marketing">
    <header className="marketing-nav wrap">
      <Brand />
      <nav className="marketing-links" aria-label="Main navigation">
        <a href="#platform">Platform</a><a href="#principles">Why Veyra</a><a href="#trust">Trust</a>
      </nav>
      <div className="nav-actions"><Link href="/create-invoice" className="text-link">Create an invoice</Link>{user ? <Link href="/app" className="button button-dark button-small">Go to workspace <ArrowRight size={15} /></Link> : <><Link href="/sign-in" className="text-link">Sign in</Link><Link href="/sign-up" className="button button-dark button-small">Open your workspace <ArrowRight size={15} /></Link></>}</div>
    </header>
    <section className="hero wrap">
      <div className="hero-copy">
        <div className="eyebrow"><span className="eyebrow-line" /> FINANCE, IN ONE PLACE</div>
        <h1>Pay across chains.<br /><em>Run your business.</em></h1>
        <p className="hero-sub">Veyra is the global payments and finance workspace for independent people and ambitious teams. Create invoices, pay people, and direct your funds with your own wallet.</p>
        <div className="hero-ctas"><Link href="/create-invoice" className="button button-green">Create an invoice</Link><Link href={user ? '/app' : '/sign-up'} className="button button-outline">{user ? 'Go to workspace' : 'Open a workspace'}</Link></div>
        <div className="hero-proof"><span>Clear records. No imagined balances.<br /><b>Built for financial clarity.</b></span></div>
      </div>
      <div className="hero-sidecard hero-sidecard-left">
        <span className="hero-sidecard-kicker">RECORD CLARITY</span>
        <strong>Know what happened.</strong>
        <span className="hero-sidecard-flow"><i>Draft</i><b /><i>Saved</i><b /><i>Settled</i></span>
        <small>Each step clearly recorded</small>
      </div>
      <div className="hero-visual" aria-label="Illustrative Veyra workspace preview">
        <div className="preview-window">
          <div className="preview-window-bar"><span className="preview-brand"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span> Veyra</span><span className="preview-label">ILLUSTRATIVE PREVIEW</span></div>
          <div className="preview-app">
            <aside className="preview-sidebar" aria-hidden="true">
              <span className="preview-rail-mark"><span /><span /><span /></span>
              <span className="preview-nav-item is-active"><Layers3 size={15} />Overview</span>
              <span className="preview-nav-item"><FileText size={15} />Invoices</span>
              <span className="preview-nav-item"><Users size={15} />People</span>
              <span className="preview-nav-item"><Wallet size={15} />Treasury</span>
            </aside>
            <div className="preview-main">
              <div className="preview-heading"><div><span className="preview-kicker">YOUR WORKSPACE</span><h2>Overview</h2></div><span className="preview-avatar">T</span></div>
              <div className="preview-metrics"><div><span>INVOICES</span><strong>Drafts &amp; due dates</strong><small>Keep every detail together</small></div><div><span>PAYROLL</span><strong>People &amp; preparation</strong><small>Review before approval</small></div><div><span>TREASURY</span><strong>Saved preferences</strong><small>Your plan, clearly recorded</small></div></div>
              <div className="preview-activity"><div className="preview-activity-head"><strong>Recent activity</strong><span>Sample workspace</span></div><div className="preview-row"><span className="preview-row-icon"><FileText size={15} /></span><span><b>Invoice draft</b><small>Ready for your review</small></span><i>Draft</i></div><div className="preview-row"><span className="preview-row-icon"><SlidersHorizontal size={15} /></span><span><b>Allocation preferences</b><small>Saved to your workspace</small></span><i className="saved-pill">Saved</i></div></div>
            </div>
          </div>
          <div className="preview-window-foot"><span>Thoughtful tools for financial clarity</span><span><span className="preview-status-dot" /> Nothing moves without you</span></div>
        </div>
        <div className="preview-note"><span className="preview-note-icon"><ShieldCheck size={16} /></span><span><b>Clear by design</b><small>Preferences are not transfers.</small></span></div>
      </div>
      <div className="hero-sidecard hero-sidecard-right">
        <span className="hero-sidecard-kicker">LOCAL EXCHANGE</span>
        <strong>Review comes first.</strong>
        <div className="review-stamp"><span>Manual review<small>before listing</small></span></div>
        <small>Listed payment methods stay visible</small>
      </div>
      <div className="hero-bottom-line"><span>FINANCIAL OPERATING SYSTEM</span><span className="bottom-line-track" /><span>01 / 04</span></div>
    </section>
     <section className="trust-strip" id="trust"><div className="wrap trust-inner"><span className="trust-lead">A little less financial noise.</span><span className="trust-item">Private by design</span><span className="trust-item">Vendor listings by approval</span><span className="trust-item">Made for cross-border work</span></div></section>
    <section className="platform-section wrap" id="platform">
      <div className="section-intro"><div className="eyebrow"><span className="eyebrow-line" /> THE WHOLE PICTURE</div><h2>One workspace.<br /><em>Fewer loose ends.</em></h2><p>Veyra brings the working parts of your finances together without pretending to do what it cannot.</p></div>
      <div className="platform-grid">
        <article className="platform-feature feature-large"><div className="feature-top"><span className="feature-num">01 / DOCUMENTS</span><FileText size={20} /></div><div className="paper-stack"><div className="paper paper-back" /><div className="paper paper-front"><span className="paper-dot" /><span className="paper-line wide" /><span className="paper-line" /><span className="paper-total">USDC 2,840.00</span><span className="paper-foot">INVOICE · PAYMENT LINK</span></div></div><h3>Invoices, ready when you are.</h3><p>Create an invoice with or without a workspace. Recipients must have a Veyra account to receive it.</p><Link href="/create-invoice" className="feature-link">Create an invoice <ArrowRight size={15} /></Link></article>
        <article className="platform-feature feature-people"><div className="feature-top"><span className="feature-num">02 / PEOPLE</span><Users size={19} /></div><div className="people-graphic"><span className="person-chip chip-one">AM</span><span className="person-chip chip-two">JK</span><span className="person-chip chip-three">SN</span><span className="people-connect" /><span className="people-caption">Your people, your preferences</span></div><h3>Keep your team in view.</h3><p>Invite your team, save their payout preferences, and prepare pay runs when you’re ready.</p><Link href="/sign-up" className="feature-link">Explore the organization workspace <ArrowRight size={15} /></Link></article>
         <article className="platform-feature feature-allocations"><div className="feature-top"><span className="feature-num">03 / PREFERENCES</span><SlidersHorizontal size={19} /></div><div className="allocation-mini"><span className="allocation-arc" /><div><strong>50 / 30 / 20</strong><small>Example allocation</small></div></div><h3>Plan with intention.</h3><p>Set tax, savings, and spending preferences. Your choices are saved as preferences only, not transfers.</p><Link href="/sign-up" className="feature-link">Set your preferences <ArrowRight size={15} /></Link></article>
      </div>
    </section>
    <section className="statement-band" id="principles"><div className="wrap statement-inner"><div className="statement-index">OUR POINT OF VIEW <span>02 / 04</span></div><h2>Trust is not a badge.<br />It is <em>knowing what happened.</em></h2><p>Veyra distinguishes what is saved from what is settled. You will always know when something is a draft, a preference, or an actual record.</p></div></section>
      <section className="vendors-section wrap"><div className="vendor-copy"><div className="eyebrow"><span className="eyebrow-line" /> LOCAL EXCHANGE</div><h2>Local access,<br /><em>coming soon.</em></h2><p>Veyra is preparing a local exchange service. It is not available yet, and no trades or settlements happen through Veyra today.</p><span className="coming-soon-pill">Coming soon</span></div><div className="vendor-preview"><div className="vp-head"><div><span className="vp-kicker">VEYRA EXCHANGE</span><strong>In preparation</strong></div></div><div className="vp-list vp-list-empty"><b>Local exchange is coming soon</b><span>We will share more when the service is ready.</span></div><div className="vp-foot"><span>Not available yet</span></div></div></section>
    <section className="closing-section"><div className="wrap closing-inner"><div><div className="eyebrow">MAKE SPACE FOR YOUR WORK</div><h2>Keep the money side<br /><em>in good order.</em></h2></div><Link href="/sign-up" className="button button-cream">Start with Veyra <ArrowRight size={16} /></Link><div className="closing-note">Share invoice links. Track verified settlement.<br />Keep your finances in one place.</div></div></section>
      <footer className="marketing-footer wrap"><Brand /><span>Pay across chains. Run your business.</span><div><a href="#trust">Trust & clarity</a><Link href="/sign-in">Sign in</Link></div><small>© 2026 Veyra Finance</small></footer>
  </main>;
}

function SignInPage() {
  const { signIn, authError } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try {
      await signIn('', '');
      navigate(postSignInPath());
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign in failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-page">
      <div className="auth-side">
        <Brand light />
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> YOUR WORK, IN RHYTHM</div>
          <h1>Welcome back<br /><em>to your workspace.</em></h1>
          <p>Pick up where you left off. Your financial records are right where you saved them.</p>
        </div>
        <span className="auth-note">A financial operating system for people who work everywhere.</span>
      </div>
      <div className="auth-form-side">
        <Link href="/" className="auth-back"><ArrowDownRight size={15} /> Back to Veyra</Link>
        <div style={{ width: '100%', maxWidth: 400 }}>
          <span className="page-eyebrow">SIGN IN</span>
          <h2 style={{ margin: '10px 0 24px', fontSize: 24, fontWeight: 700, letterSpacing: '-.04em' }}>Access your workspace</h2>
          <form className="form-stack" onSubmit={submit}>
            <p>Sign in with the email linked to your Veyra account. Privy will verify your email and open your workspace.</p>
            {authError && <p className="form-error" role="alert">{authError}</p>}
            {error && <p className="form-error">{error}</p>}
            <button className="button button-green" disabled={busy} style={{ width: '100%', marginTop: 4 }}>{busy ? 'Opening Privy…' : 'Continue with Privy'} <ArrowRight size={15} /></button>
          </form>
          <p style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: '#7a9490' }}>
            No account? <Link href="/sign-up" style={{ color: '#1a7a5e', fontWeight: 600 }}>Create one</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function SignUpPage() {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setBusy(true);
    try { await signUp('', '', name); navigate('/app'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Registration failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-page">
      <div className="auth-side">
        <Brand light />
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> A CLEARER START</div>
          <h1>Make room for<br /><em>your next chapter.</em></h1>
          <p>Create a workspace for your independent work or the team you are building.</p>
        </div>
        <span className="auth-note">Your money deserves a little more order.</span>
      </div>
      <div className="auth-form-side">
        <Link href="/" className="auth-back"><ArrowDownRight size={15} /> Back to Veyra</Link>
        <div style={{ width: '100%', maxWidth: 400 }}>
          <span className="page-eyebrow">CREATE ACCOUNT</span>
          <h2 style={{ margin: '10px 0 24px', fontSize: 24, fontWeight: 700, letterSpacing: '-.04em' }}>Open your workspace</h2>
          <form className="form-stack" onSubmit={submit}>
            <label>Your name<input type="text" required value={name} onChange={e => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" /></label>
            <p>Privy will verify your email and create your Veyra account with your testnet wallet.</p>
            {error && <p className="form-error">{error}</p>}
            <button className="button button-green" disabled={busy} style={{ width: '100%', marginTop: 4 }}>{busy ? 'Opening Privy…' : 'Create account with Privy'} <ArrowRight size={15} /></button>
          </form>
          <p style={{ marginTop: 20, textAlign: 'center', fontSize: 12, color: '#7a9490' }}>
            Already have an account? <Link href="/sign-in" style={{ color: '#1a7a5e', fontWeight: 600 }}>Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function AuthActionLayout({ title, children }: { title: string; children: ReactNode }) {
  return <div className="auth-page"><div className="auth-side"><Brand light /><div><div className="eyebrow"><span className="eyebrow-line" /> ACCOUNT SECURITY</div><h1>Keep your account<br /><em>in your hands.</em></h1><p>{title}</p></div><span className="auth-note">Use secure, one-time links sent for your account.</span></div><div className="auth-form-side"><Link href="/" className="auth-back"><ArrowDownRight size={15} /> Back to Veyra</Link><div style={{ width: '100%', maxWidth: 400 }}>{children}</div></div></div>;
}

function VerifyEmailPage() {
  const [message, setMessage] = useState('Verifying your email…');
  const [error, setError] = useState('');
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) { setMessage(''); setError('This verification link is missing or invalid.'); return; }
    void apiFetch(`${API_BASE}/auth/verify-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Verification failed.'); setMessage(data.message || 'Email verified.'); })
      .catch((reason) => { setMessage(''); setError(reason instanceof Error ? reason.message : 'Verification failed.'); });
  }, []);
  return <AuthActionLayout title="Verify your email address."><span className="page-eyebrow">EMAIL VERIFICATION</span><h2 style={{ margin: '10px 0 18px', fontSize: 24, fontWeight: 700 }}>Confirm your email</h2>{message && <p role="status">{message}</p>}{error && <p className="form-error">{error}</p>}<Link href="/sign-in" className="button button-green" style={{ display: 'inline-flex', marginTop: 20 }}>Continue to sign in <ArrowRight size={15} /></Link></AuthActionLayout>;
}

function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [resetUrl, setResetUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(''); setResetUrl('');
    try { const response = await apiFetch(`${API_BASE}/auth/forgot-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not request a reset link.'); setMessage(data.message); setResetUrl(data.resetUrl || ''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not request a reset link.'); }
    finally { setBusy(false); }
  };
  return <AuthActionLayout title="Recover access without exposing account details."><span className="page-eyebrow">PASSWORD RECOVERY</span><h2 style={{ margin: '10px 0 18px', fontSize: 24, fontWeight: 700 }}>Reset your password</h2><form className="form-stack" onSubmit={submit}><label>Email<input type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}{message && <p role="status">{message}</p>}{resetUrl && <p>Local development link: <a href={resetUrl}>Reset password</a></p>}<button className="button button-green" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'} <ArrowRight size={15} /></button></form><p style={{ marginTop: 18 }}><Link href="/sign-in">Back to sign in</Link></p></AuthActionLayout>;
}

function ResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { const response = await apiFetch(`${API_BASE}/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not update the password.'); setMessage(data.message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update the password.'); }
    finally { setBusy(false); }
  };
  return <AuthActionLayout title="Choose a new password for your Veyra account."><span className="page-eyebrow">PASSWORD RECOVERY</span><h2 style={{ margin: '10px 0 18px', fontSize: 24, fontWeight: 700 }}>Choose a new password</h2>{message ? <p role="status">{message} <Link href="/sign-in">Sign in</Link></p> : <form className="form-stack" onSubmit={submit}><label>New password<input type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{error && <p className="form-error">{error}</p>}<button className="button button-green" disabled={busy || !token}>{busy ? 'Updating…' : 'Update password'} <ArrowRight size={15} /></button></form>}</AuthActionLayout>;
}

const navItems = [
  { href: '/app', label: 'Overview', icon: Layers3, section: 'WORKSPACE' },
  { href: '/app/wallets', label: 'Wallets', icon: Wallet, section: 'WORKSPACE' },
  { href: '/app/invoices', label: 'Invoices', icon: FileText, section: 'WORKSPACE' },
  { href: '/app/payables', label: 'Bills to pay', icon: FilePlus2, section: 'WORKSPACE' },
  { href: '/app/organization', label: 'Organization', icon: Users, section: 'WORKSPACE' },
  { href: '/app/treasury', label: 'Treasury', icon: Coins, section: 'TREASURY' },
  { href: '/app/exchange', label: 'Local exchange · Coming soon', icon: Globe2, section: 'NETWORK' },
  { href: '/app/records', label: 'All records', icon: BriefcaseBusiness, section: 'NETWORK' },
  { href: '/app/admin/vendors', label: 'Vendor review', icon: ShieldCheck, section: 'ADMIN' },
];

type WorkspaceChoice = { id: string; name: string; type: 'freelancer' | 'business'; role: string };
const ACTIVE_WORKSPACE_KEY = 'trezu_active_workspace_id';

function AppFrame({ children, title, eyebrow, action }: { children: ReactNode; title: string; eyebrow: string; action?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceChoice[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => localStorage.getItem(ACTIVE_WORKSPACE_KEY) || '');
  const { user, signOut } = useAuth();
  const profile = useGetProfile({ query: { queryKey: getGetProfileQueryKey() } });
  const queryClient = useQueryClient();
  const [location] = useLocation();
  const [, navigate] = useLocation();
  const [tourStep, setTourStepState] = useState<number | null>(() => {
    const saved = sessionStorage.getItem(FREELANCER_TOUR_SESSION_KEY);
    const parsed = saved === null ? null : Number(saved);
    return parsed !== null && Number.isInteger(parsed) && parsed >= 0 && parsed < freelancerTourSteps.length ? parsed : null;
  });
  const setTourStep = useCallback((step: number | null) => {
    if (step === null) {
      sessionStorage.removeItem(FREELANCER_TOUR_SESSION_KEY);
      localStorage.setItem(FREELANCER_TOUR_DONE_KEY, 'true');
    } else sessionStorage.setItem(FREELANCER_TOUR_SESSION_KEY, String(step));
    setTourStepState(step);
  }, []);
  const startTour = useCallback(() => { localStorage.removeItem(FREELANCER_TOUR_DONE_KEY); setTourStep(0); }, [setTourStep]);
  useEffect(() => {
    window.addEventListener('trezu:freelancer-tour-start', startTour);
    return () => window.removeEventListener('trezu:freelancer-tour-start', startTour);
  }, [startTour]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    apiFetch('/api/workspaces').then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Your workspaces could not be loaded.');
      const choices = body.workspaces as WorkspaceChoice[];
      if (!active) return;
      setWorkspaces(choices);
      const storedId = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
      const storedWorkspace = choices.find((workspace) => workspace.id === storedId);
      const selected = (storedWorkspace?.role === 'employee' && location !== '/app/organization'
        ? choices.find((workspace) => workspace.role !== 'employee')
        : storedWorkspace)
        || choices.find((workspace) => workspace.id === profile.data?.workspaceId)
        || choices[0];
      if (selected && selected.id !== storedId) {
        localStorage.setItem(ACTIVE_WORKSPACE_KEY, selected.id);
        setActiveWorkspaceId(selected.id);
        void queryClient.invalidateQueries();
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [user?.id, profile.data?.workspaceId, location, queryClient]);
  const initials = user ? `${user.name.split(' ')[0]?.[0] ?? ''}${user.name.split(' ')[1]?.[0] ?? ''}`.toUpperCase() || user.email[0].toUpperCase() : 'T';
  const personalProfileActive = location === '/app/account';
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) || workspaces.find((workspace) => workspace.id === profile.data?.workspaceId);
  const chooseWorkspace = (workspace: WorkspaceChoice) => {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
    setActiveWorkspaceId(workspace.id);
    setWorkspaceMenuOpen(false);
    queryClient.clear();
    navigate(workspace.type === 'business' ? '/app/organization' : '/app');
  };
  return <div className="app-shell">
    <aside id="app-sidebar" className={`app-sidebar ${open ? 'sidebar-open' : ''}`} aria-hidden={!open && window.matchMedia('(max-width: 760px)').matches}>
      <div className="sidebar-brand"><Brand light /><button type="button" className="mobile-close icon-button" onClick={() => setOpen(false)} aria-label="Close menu"><X size={18} /></button></div>
      <div className="workspace-switcher">
        <button type="button" className="workspace-switch" onClick={() => setWorkspaceMenuOpen((value) => !value)} aria-expanded={workspaceMenuOpen} aria-label="Switch workspace">
          <span className="workspace-avatar">{personalProfileActive ? 'M' : (activeWorkspace?.name || profile.data?.workspaceName || 'T').charAt(0).toUpperCase()}</span>
          <span><b>{personalProfileActive ? 'Mine' : activeWorkspace?.name || profile.data?.workspaceName || 'Your workspace'}</b><small>{personalProfileActive ? 'Personal profile' : activeWorkspace ? `${activeWorkspace.type === 'business' ? 'Organization' : 'Freelance'} · ${activeWorkspace.role}` : 'Financial home'}</small></span>
          <ChevronDown size={15} />
        </button>
        {workspaceMenuOpen && <div className="workspace-menu" role="menu" aria-label="Your workspaces"><button type="button" role="menuitem" className={personalProfileActive ? 'workspace-menu-active' : ''} onClick={() => { setWorkspaceMenuOpen(false); setOpen(false); navigate('/app/account'); }}><span><b>Mine</b><small>Personal profile · wallets and settings</small></span>{personalProfileActive && <Check size={16} />}</button>{workspaces.map((workspace) => <button type="button" role="menuitem" key={workspace.id} onClick={() => chooseWorkspace(workspace)} className={!personalProfileActive && workspace.id === activeWorkspace?.id ? 'workspace-menu-active' : ''}><span><b>{workspace.name}</b><small>{workspace.type === 'business' ? 'Organization' : 'Freelance'} · {workspace.role}</small></span>{!personalProfileActive && workspace.id === activeWorkspace?.id && <Check size={16} />}</button>)}<button type="button" role="menuitem" className="workspace-menu-create" onClick={() => { setWorkspaceMenuOpen(false); setOpen(false); navigate('/app/organization/new'); }}><span><b>+ Create organization</b><small>Set up a team workspace</small></span><ArrowRight size={15} /></button></div>}
      </div>
      <nav className="side-nav" aria-label="Workspace navigation">
        {['WORKSPACE', 'TREASURY', 'NETWORK', 'ADMIN'].map((section) => <div className="nav-section" key={section}>{navItems.filter((item) => { const managerOnly = ['/app/treasury', '/app/records'].includes(item.href); const canManage = profile.data?.role === 'owner' || profile.data?.role === 'admin'; const businessWorkspace = profile.data?.workspaceType === 'business'; const organizationAllowed = workspaces.some((workspace) => workspace.type === 'business'); return item.section === section && (item.href !== '/app/organization' || organizationAllowed) && (!managerOnly || (businessWorkspace && canManage)) && (section !== 'ADMIN' || profile.data?.role === 'platform_admin'); }).map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setOpen(false)} className={`side-link ${location === href ? 'side-link-active' : ''}`} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{href === '/app/records' && <span className="side-link-arrow"><ArrowUpRight size={13} /></span>}</Link>)}</div>)}
      </nav>
      <div className="sidebar-bottom"><button type="button" className="user-menu" onClick={() => signOut().then(() => navigate('/'))} data-testid="button-sign-out"><span className="user-initial">{initials}</span><span className="user-details"><b>{user?.name ?? 'Your account'}</b><small>{user?.email ?? 'Signed in'}</small></span><ArrowDownRight size={14} /></button></div>
    </aside>
    {open && <button type="button" className="sidebar-scrim" onClick={() => setOpen(false)} aria-label="Close navigation" />}
    <section className="app-main">
      <header className="app-topbar"><button type="button" className="mobile-menu icon-button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls="app-sidebar" aria-label={open ? 'Close menu' : 'Open menu'}><Menu size={20} /></button><div className="topbar-breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><b>{title}</b></div><div className="topbar-right"><span className="secure-label"><LockKeyhole size={13} /> Private workspace</span><Link href="/app/account" className="topbar-user" aria-label="Account and wallets">{initials}</Link></div></header>
      <main className="page-content"><div className="page-heading"><div><span className="page-eyebrow">{eyebrow}</span><h1>{title}</h1></div>{action}</div>{children}<footer className="app-footer"><span>Veyra keeps a clear record of what is saved.</span><span>Need help? <b>We are here.</b></span></footer></main>
    </section>
    {tourStep !== null && <FreelancerTour stepIndex={tourStep} location={location} navigate={navigate} setStep={setTourStep} />}
  </div>;
}

function Protected({ children }: { children: ReactNode }) {
  const { isLoaded, user } = useAuth();
  const [location] = useLocation();
  if (!isLoaded) return <div className="auth-loading"><div className="loading-mark"><span /><span /><span /></div><span>Preparing your workspace</span></div>;
  if (!user) return <Redirect to={`/sign-in?next=${encodeURIComponent(location)}`} />;
  return <>{children}</>;
}

function StatePanel({ kind, title, text, retry }: { kind: 'loading' | 'error' | 'empty'; title: string; text: string; retry?: () => void }) {
  return <div className={`state-panel state-${kind}`}><div className="state-art">{kind === 'loading' ? <div className="skeleton-bars"><i /><i /><i /></div> : kind === 'error' ? <CircleHelp size={21} /> : <Layers3 size={21} />}</div><div><h3>{title}</h3><p>{text}</p>{kind === 'error' && retry && <button className="text-button" onClick={retry}>Try again <ArrowRight size={14} /></button>}</div></div>;
}

function WorkspaceSetup() {
  const profile = useGetProfile({ query: { queryKey: getGetProfileQueryKey() } });
  const create = useCreateWorkspace();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<'freelancer' | 'business'>('freelancer');
  if (profile.isLoading) return <StatePanel kind="loading" title="Getting things in order" text="Loading your workspace profile." />;
  if (profile.isError) return <StatePanel kind="error" title="We could not load your profile" text="Check your connection and try again." retry={() => profile.refetch()} />;
  if (profile.data?.workspaceId) return <DashboardPage />;
  const submit = (event: FormEvent) => { event.preventDefault(); create.mutate({ data: { name: name.trim(), type } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetProfileQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); } }); };
  return <AppFrame title="Set up your workspace" eyebrow="YOUR FIRST STEP">
    <div className="setup-layout">
      <section className="setup-card">
        <div className="setup-mark"><Layers3 size={23} /></div>
        <span className="page-eyebrow">YOUR FREELANCE FINANCIAL HOME</span>
        <h2>Start with a name for your workspace.</h2>
        <p>Your workspace is where you create client invoices and payment links, then track confirmed payments. It is not a bank account, and creating it will not move any money.</p>
        <form onSubmit={submit} className="form-stack">
          <label>Workspace name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ada Studio" data-testid="input-workspace-name" /></label>
          <label>How will you use Veyra?<select value={type} onChange={(e) => setType(e.target.value as 'freelancer' | 'business')} data-testid="select-workspace-type"><option value="freelancer">I work independently</option><option value="business">I run a team or business</option></select></label>
          {create.isError && <p className="form-error">We could not create your workspace. Please try again.</p>}
          <button className="button button-green" disabled={create.isPending}>{create.isPending ? 'Creating workspace…' : 'Create my workspace'} <ArrowRight size={15} /></button>
        </form>
      </section>
      <aside className="setup-guide" aria-label="What you will do next">
        <span className="page-eyebrow">WHAT HAPPENS NEXT</span>
        <h2>A simple start, at your pace.</h2>
        <ol>
          <li><span>1</span><div><b>Create and send an invoice</b><p>Add the work, amount, settlement asset, and receiving address. Then email it to the recipient’s registered Veyra account.</p></div></li>
          <li><span>2</span><div><b>Share the checkout link</b><p>Your client opens the link and follows the provider’s checkout instructions. Veyra does not email it for you.</p></div></li>
          <li><span>3</span><div><b>Track confirmed payment</b><p>For this test version, payments use testnet tokens. Veyra marks an invoice paid only after settlement is confirmed.</p></div></li>
        </ol>
        <p className="setup-guide-note">You can also explore the dashboard without connecting a wallet. Payroll is for teams, and Local Exchange is not available yet.</p>
      </aside>
    </div>
  </AppFrame>;
}

function DashboardPage() {
  const dashboard = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  const records = useGetRecords({ query: { queryKey: getGetRecordsQueryKey() } });
  const [attention, setAttention] = useState<{ bills: number | null; payroll: number | null }>({ bills: null, payroll: null });
  useEffect(() => {
    if (dashboard.data?.workspaceType === 'freelancer' && !localStorage.getItem(FREELANCER_TOUR_DONE_KEY) && !sessionStorage.getItem(FREELANCER_TOUR_SESSION_KEY)) requestFreelancerTour();
  }, [dashboard.data?.workspaceType]);
  useEffect(() => {
    if (!dashboard.data) return;
    let cancelled = false;
    void (async () => {
      const canManagePayroll = dashboard.data?.workspaceType === 'business' && ['owner', 'admin'].includes(dashboard.data.role);
      const [invoiceResponse, payrollResponse] = await Promise.all([
        apiFetch('/api/received-invoices').catch(() => null),
        canManagePayroll ? apiFetch('/api/payroll/cycles').catch(() => null) : Promise.resolve(null),
      ]);
      let bills: number | null = null;
      let payroll: number | null = canManagePayroll ? null : 0;
      if (invoiceResponse?.ok) {
        const body = await invoiceResponse.json().catch(() => ({}));
        bills = ((body.invoices || []) as Array<{ status: string; amountDue?: string; amount?: string }>).filter((invoice) => !['paid', 'cancelled'].includes(invoice.status) && Number(invoice.amountDue ?? invoice.amount) > 0).length;
      }
      if (payrollResponse?.ok) {
        const cycles = await payrollResponse.json().catch(() => []);
        payroll = (cycles as PayrollCycleSummary[]).reduce((total, cycle) => total + cycle.items.filter((item) => item.status !== 'paid').length, 0);
      }
      if (!cancelled) setAttention({ bills, payroll });
    })();
    return () => { cancelled = true; };
  }, [dashboard.data?.workspaceName, dashboard.data?.role, dashboard.data?.workspaceType]);
  if (dashboard.isLoading) return <AppFrame title="Overview" eyebrow="YOUR FINANCIAL HOME"><StatePanel kind="loading" title="Gathering your workspace" text="Your overview is getting ready." /><div className="skeleton-dashboard"><i /><i /><i /></div></AppFrame>;
  if (dashboard.isError || !dashboard.data) return <AppFrame title="Overview" eyebrow="YOUR FINANCIAL HOME"><StatePanel kind="error" title="Your overview is taking a moment" text="We could not load your workspace data." retry={() => dashboard.refetch()} /></AppFrame>;
  const data = dashboard.data;
  const isFreelancer = data.workspaceType === 'freelancer';
  const canManagePayroll = data.workspaceType === 'business' && ['owner', 'admin'].includes(data.role);
  const recentRecords = (records.data || []).slice(0, 6);
  return <AppFrame title="Overview" eyebrow={`GOOD TO SEE YOU · ${data.workspaceName.toUpperCase()}`}>
    {data.workspaceType === 'freelancer' && <FreelancerStartGuide />}
    <section className="overview-welcome"><div><span className="page-eyebrow">{isFreelancer ? 'FREELANCE WORKSPACE' : data.role === 'employee' ? 'TEAM WORKSPACE' : 'ORGANIZATION WORKSPACE'}</span><h2>{isFreelancer ? 'What needs your attention?' : `Welcome to ${data.workspaceName}`}</h2><p>{isFreelancer ? 'Your invoices, payments, and treasury activity in one place.' : 'Your team’s invoices, payables, and activity in one place.'}</p></div><Link href="/app/wallets" className="button button-outline"><Wallet size={16} /> Wallets & balances</Link></section>
    <div className="overview-action-grid">
      <Link href="/app/invoices" className="overview-action-card"><span className="overview-action-icon"><FilePlus2 size={19} /></span><span><b>{isFreelancer ? 'Create an invoice' : 'Invoices'}</b><small>{isFreelancer ? 'Prepare and send a client invoice.' : 'Create, send, and review invoices.'}</small></span><ArrowRight size={16} /></Link>
      <Link href="/app/payables" className="overview-action-card"><span className="overview-action-icon"><FileText size={19} /></span><span><b>Bills to pay</b><small>Review received invoices and payments due.</small></span><ArrowRight size={16} /></Link>
      {!isFreelancer && ['owner', 'admin'].includes(data.role) && <Link href="/app/payroll" className="overview-action-card"><span className="overview-action-icon"><Users size={19} /></span><span><b>Organization payroll</b><small>Prepare a pay run and pay your team.</small></span><ArrowRight size={16} /></Link>}
      {isFreelancer && <Link href="/app/treasury" className="overview-action-card"><span className="overview-action-icon"><SlidersHorizontal size={19} /></span><span><b>Treasury settings</b><small>Choose how to allocate funds you receive.</small></span><ArrowRight size={16} /></Link>}
      {!isFreelancer && data.role === 'employee' && <Link href="/app/account" className="overview-action-card"><span className="overview-action-icon"><Wallet size={19} /></span><span><b>Your payout details</b><small>Review the wallet saved for team payments.</small></span><ArrowRight size={16} /></Link>}
    </div>
    <section className="overview-attention-card"><div className="overview-section-heading"><div><span className="page-eyebrow">OPEN ITEMS</span><h2>Needs attention</h2></div><Link href="/app/payables" className="text-link">Review bills <ArrowRight size={14} /></Link></div><div className="overview-attention-items"><Link href="/app/payables" className="overview-attention-item"><span className="overview-attention-count">{attention.bills ?? '—'}</span><span><b>Unpaid invoices</b><small>Invoices received by this account</small></span><ArrowRight size={15} /></Link>{canManagePayroll && <Link href="/app/payroll" className="overview-attention-item"><span className="overview-attention-count">{attention.payroll ?? '—'}</span><span><b>Unpaid team payments</b><small>Payments across your prepared pay runs</small></span><ArrowRight size={15} /></Link>}</div></section>
    <div className="overview-activity-layout"><section className="overview-activity-card"><div className="overview-section-heading"><div><span className="page-eyebrow">LATEST UPDATES</span><h2>Recent activity</h2></div><Link href="/app/records" className="text-link">All records <ArrowRight size={14} /></Link></div>
      {records.isLoading ? <StatePanel kind="loading" title="Loading activity" text="Recent workspace records are on their way." /> : records.isError ? <StatePanel kind="error" title="Activity did not load" text="Try again to load recent workspace records." retry={() => records.refetch()} /> : recentRecords.length ? <div className="overview-record-list">{recentRecords.map((record) => <Link key={record.id} href="/app/records" className="overview-record-row"><span className="overview-record-icon">{record.recordType === 'invoice' ? <FileText size={17} /> : record.recordType.startsWith('payroll') ? <Users size={17} /> : <Coins size={17} />}</span><span className="overview-record-main"><b>{record.title}</b><small>{recordTypeName(record.recordType)} · {formatDate(record.createdAt)}</small></span><span className={`status-pill ${record.status.toLowerCase().includes('confirm') || record.status.toLowerCase() === 'paid' ? 'status-paid' : record.status.toLowerCase().includes('pending') ? 'status-pending' : 'status-muted'}`}><span />{record.status}</span><ArrowRight size={14} /></Link>)}</div> : <div className="overview-activity-empty"><BriefcaseBusiness size={21} /><b>No activity yet</b><span>Invoices, confirmed payments, and team activity will appear here.</span><Link href="/app/invoices" className="button button-outline button-small">Create your first invoice</Link></div>}
    </section><aside className="overview-context-card"><span className="page-eyebrow">WORKSPACE SNAPSHOT</span><h2>{data.workspaceName}</h2><dl><div><dt>Invoices created</dt><dd>{data.invoiceCount}</dd></div>{!isFreelancer && <div><dt>Active team members</dt><dd>{data.employeeCount}</dd></div>}<div><dt>Saved records</dt><dd>{records.data?.length ?? '—'}</dd></div></dl><Link href="/app/records" className="button button-outline">View financial records <ArrowRight size={15} /></Link><p>Wallet balances and addresses are available on the Wallets page. Balances shown there come from the selected test network.</p></aside></div>
  </AppFrame>;
}

function FreelancerStartGuide() {
  return <div className="freelancer-tour-launcher"><span className="guide-icon"><CircleHelp size={17} /></span><div><b>New to Veyra?</b><small>Take the guided tour through your first invoice.</small></div><button className="button button-outline button-small" onClick={requestFreelancerTour}>Start tour <ArrowRight size={14} /></button></div>;
}

function FreelancerTour({ stepIndex, location, navigate, setStep }: { stepIndex: number; location: string; navigate: (to: string) => void; setStep: (step: number | null) => void }) {
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const step = freelancerTourSteps[stepIndex];

  useEffect(() => {
    if (location !== step.route) { navigate(step.route); return; }
    let attempts = 0;
    let frame = 0;
    let retryTimer = 0;
    const findTarget = () => {
      const target = document.querySelector<HTMLElement>(step.target);
      if (!target) {
        // Dashboard data and invoice dialogs can take longer to appear on
        // mobile networks. Keep the tour card available while waiting.
        if (attempts++ < 60) retryTimer = window.setTimeout(() => { frame = requestAnimationFrame(findTarget); }, 100);
        return;
      }
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const update = () => {
        const bounds = target.getBoundingClientRect();
        setRect({ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height });
      };
      update();
      window.addEventListener('resize', update);
      window.addEventListener('scroll', update, true);
      cleanupPosition = () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
    };
    let cleanupPosition = () => {};
    frame = requestAnimationFrame(findTarget);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(retryTimer); cleanupPosition(); };
  }, [location, navigate, step]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setStep(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [setStep]);

  const advance = () => {
    if (step.action === 'open-invoice' || step.action === 'open-invoice-and-finish') document.querySelector<HTMLButtonElement>('[data-testid="button-new-invoice"]')?.click();
    if (step.action === 'close-invoice') document.querySelector<HTMLButtonElement>('.modal-card button[aria-label="Close dialog"]')?.click();
    if (step.action === 'open-invoice-and-finish') { setStep(null); return; }
    const nextIndex = stepIndex + 1;
    if (nextIndex >= freelancerTourSteps.length) { setStep(null); return; }
    const next = freelancerTourSteps[nextIndex];
    setStep(nextIndex);
    if (location !== next.route) navigate(next.route);
  };

  return <>
    <div className="tour-click-catcher" aria-hidden="true" />
    {rect && <div className="tour-focus-frame" aria-hidden="true" style={{ top: rect.top - 7, left: rect.left - 7, width: rect.width + 14, height: rect.height + 14 }} />}
    <section className={`tour-card ${rect ? 'tour-card-positioned' : 'tour-card-fallback'}`} style={rect ? tourCardPosition(rect) : undefined} role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="tour-progress"><span>FREELANCER TOUR</span><b>STEP {stepIndex + 1} OF {freelancerTourSteps.length}</b></div>
      <h2 id="tour-title">{step.title}</h2><p>{step.text}</p>
      <div className="tour-actions"><button className="text-button" onClick={() => setStep(null)}>Skip tour</button><button className="button button-green" onClick={advance}>{step.next} <ArrowRight size={15} /></button></div>
    </section>
  </>;
}

function tourCardPosition(rect: { top: number; left: number; width: number; height: number }) {
  const width = Math.min(380, window.innerWidth - 32);
  const left = Math.max(16, Math.min(window.innerWidth - width - 16, rect.left + rect.width / 2 - width / 2));
  const below = rect.top + rect.height + 20;
  const top = below + 190 < window.innerHeight ? below : Math.max(16, rect.top - 220);
  return { top, left, width };
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', close); document.body.style.overflow = 'hidden'; return () => { window.removeEventListener('keydown', close); document.body.style.overflow = ''; }; }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-top"><div><span className="page-eyebrow">VEYRA WORKSPACE</span><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</section></div>;
}

function decimalToMicros(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) return 0n;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
}

function microsToDecimal(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function InvoicesPage() {
  const privy = usePrivyWallet();
  const profile = useGetProfile({ query: { queryKey: getGetProfileQueryKey() } });
  const canManageInvoices = ['owner', 'admin'].includes(profile.data?.role || '');
  const list = useGetInvoices({ query: { queryKey: getGetInvoicesQueryKey(), enabled: canManageInvoices } });
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [notice, setNotice] = useState('');
  const [invoiceAssets, setInvoiceAssets] = useState<{ assetId: string; symbol: string; blockchain: string }[]>([]);
  const [invoiceAssetId, setInvoiceAssetId] = useState('');
  const [invoiceRecipient, setInvoiceRecipient] = useState('');
  const [useCustomInvoiceRecipient, setUseCustomInvoiceRecipient] = useState(false);
  const [privyNearAddress, setPrivyNearAddress] = useState('');
  const [personalReceiveDefaults, setPersonalReceiveDefaults] = useState<{ near?: string; evm?: string }>({});
  const [invoiceCurrency, setInvoiceCurrency] = useState('USD');
  const [invoiceAssetsLoading, setInvoiceAssetsLoading] = useState(false);
  const [invoiceView, setInvoiceView] = useState<'created' | 'received'>(() => new URLSearchParams(window.location.search).get('tab') === 'received' ? 'received' : 'created');
  const [receivedInvoices, setReceivedInvoices] = useState<{ id: string; publicToken: string | null; invoiceNumber: string; senderName: string; description: string; amount: string; amountDue?: string; amountPaid?: string; currency: string; dueDate: string | null; status: string; createdAt: string; sentAt: string | null }[]>([]);
  const [receivedInvoicesLoading, setReceivedInvoicesLoading] = useState(false);
  const [receivedInvoicesError, setReceivedInvoicesError] = useState('');
  const [invoiceSaveBusy, setInvoiceSaveBusy] = useState(false);
  const [invoiceError, setInvoiceError] = useState('');
  const [sendTarget, setSendTarget] = useState<any>(null);
  const [sendEmail, setSendEmail] = useState('');
  const [sendError, setSendError] = useState('');
  const [sendBusy, setSendBusy] = useState(false);
  const [linkTarget, setLinkTarget] = useState<any>(null);
  const [linkAssets, setLinkAssets] = useState<{ assetId: string; symbol: string; blockchain: string }[]>([]);
  const [linkAsset, setLinkAsset] = useState('');
  const [linkRecipient, setLinkRecipient] = useState('');
  const [paymentLink, setPaymentLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [invoiceLines, setInvoiceLines] = useState<{ description: string; amount: string }[]>([{ description: '', amount: '' }]);
  const lineTotal = invoiceLines.reduce((sum, line) => sum + decimalToMicros(line.amount), 0n);
  useEffect(() => {
    if (!profile.data || canManageInvoices || new URLSearchParams(window.location.search).get('tab') === 'received') return;
    setInvoiceView('received');
    const url = new URL(window.location.href); url.searchParams.set('tab', 'received'); window.history.replaceState({}, '', url);
  }, [canManageInvoices, profile.data]);
  const compatibleInvoiceAssets = invoiceAssets.filter((asset) => asset.symbol.toUpperCase() === invoiceCurrency || (invoiceCurrency === 'USD' && ['USDC', 'USDT'].includes(asset.symbol.toUpperCase())));
  const selectedInvoiceAsset = invoiceAssets.find((asset) => asset.assetId === invoiceAssetId);
  const defaultInvoiceRecipient = selectedInvoiceAsset?.blockchain.toLowerCase() === 'near'
    ? personalReceiveDefaults.near || privyNearAddress
    : personalReceiveDefaults.evm || privy.privyAddress;
  const loadReceivedInvoices = useCallback(async () => {
    setReceivedInvoicesLoading(true); setReceivedInvoicesError('');
    try {
      const response = await apiFetch('/api/received-invoices');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Invoices sent to you could not be loaded.');
      setReceivedInvoices(data.invoices || []);
    } catch (error) { setReceivedInvoicesError(error instanceof Error ? error.message : 'Invoices sent to you could not be loaded.'); }
    finally { setReceivedInvoicesLoading(false); }
  }, []);
  const changeInvoiceView = (view: 'created' | 'received') => {
    setInvoiceView(view);
    const url = new URL(window.location.href);
    if (view === 'received') url.searchParams.set('tab', 'received'); else url.searchParams.delete('tab');
    window.history.replaceState(window.history.state, '', url);
  };
  useEffect(() => { if (invoiceView === 'received') void loadReceivedInvoices(); }, [invoiceView, loadReceivedInvoices]);
  const openNewInvoice = async () => {
    setNotice(''); setInvoiceError(''); setInvoiceCurrency('USD'); setInvoiceRecipient(''); setUseCustomInvoiceRecipient(false); setPrivyNearAddress(''); setInvoiceAssetId(''); setInvoiceLines([{ description: '', amount: '' }]); setPaymentLink(''); setLinkTarget(null); setModal(true); setInvoiceAssetsLoading(true);
    try {
      const [response, walletResponse] = await Promise.all([
        apiFetch('/api/integrations/near-intents/assets'),
        apiFetch('/api/auth/wallets').catch(() => null),
      ]);
      const preferenceResponse = await apiFetch('/api/personal-profile/preferences').catch(() => null);
      if (preferenceResponse?.ok) {
        const preferenceData = await preferenceResponse.json();
        setPersonalReceiveDefaults(preferenceData.defaultReceiveAddresses || {});
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Supported testnet assets could not be loaded.');
      const assets = (result.assets || []) as { assetId: string; symbol: string; blockchain: string }[];
      setInvoiceAssets(assets);
      const eligible = assets.filter((asset) => ['USDC', 'USDT'].includes(asset.symbol.toUpperCase()));
      setInvoiceAssetId(eligible[0]?.assetId || '');
      if (walletResponse?.ok) {
        const walletData = await walletResponse.json();
        const nearWallet = (walletData.wallets || []).find((wallet: { network: string; address: string; provider?: string }) => wallet.network === 'near:testnet' && wallet.provider === 'privy');
        setPrivyNearAddress(nearWallet?.address || '');
      }
    } catch (error) { setInvoiceError(error instanceof Error ? error.message : 'Supported testnet assets could not be loaded.'); }
    finally { setInvoiceAssetsLoading(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (invoiceLines.some((line) => decimalToMicros(line.amount) <= 0n)) { setInvoiceError('Every invoice item needs a positive amount.'); return; }
    if (!invoiceAssetId || !compatibleInvoiceAssets.some((asset) => asset.assetId === invoiceAssetId)) { setInvoiceError(`Choose a supported testnet settlement asset for ${invoiceCurrency}.`); return; }
    const paymentRecipient = (useCustomInvoiceRecipient ? invoiceRecipient : defaultInvoiceRecipient).trim();
    if (!paymentRecipient) { setInvoiceError('Enter the wallet address where you want to receive this invoice payment.'); return; }
    const data: InvoiceInput & { paymentAssetId: string; paymentRecipient: string } = { clientName: 'Recipient pending', clientEmail: null, description: String(form.get('description')).trim(), lineItems: invoiceLines.filter((line) => line.description.trim() && line.amount.trim()).map((line) => ({ description: line.description.trim(), amount: line.amount.trim() })), amount: microsToDecimal(lineTotal), currency: String(form.get('currency')).toUpperCase(), dueDate: String(form.get('dueDate') || '') || null, notes: String(form.get('notes') || '').trim() || null, paymentTerms: String(form.get('paymentTerms') || '').trim() || null, paymentAssetId: invoiceAssetId, paymentRecipient };
    setInvoiceError(''); setInvoiceSaveBusy(true);
    try {
      const response = await apiFetch('/api/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The invoice and payment link could not be created.');
      if (typeof result.paymentLink !== 'string') throw new Error('The invoice was saved, but the payment link was not returned. Refresh invoices before trying again.');
      qc.invalidateQueries({ queryKey: getGetInvoicesQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getGetRecordsQueryKey() });
      setModal(false); setNotice('Invoice created. Click Send to add it to the recipient’s Veyra dashboard and email them a notification.');
    } catch (error) { setInvoiceError(error instanceof Error ? error.message : 'The invoice and payment link could not be created.'); }
    finally { setInvoiceSaveBusy(false); }
  };
  const sendInvoice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!sendTarget) return; setSendBusy(true); setSendError('');
    try {
      const response = await apiFetch(`/api/invoices/${sendTarget.id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: sendEmail.trim() }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Invoice email could not be sent.');
      setSendTarget(null); setSendEmail(''); setNotice(`Invoice ${result.invoiceNumber} sent to ${result.recipientEmail}.`);
      await Promise.all([qc.invalidateQueries({ queryKey: getGetInvoicesQueryKey() }), qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }), qc.invalidateQueries({ queryKey: getGetRecordsQueryKey() })]);
    } catch (error) { setSendError(error instanceof Error ? error.message : 'Invoice email could not be sent.'); }
    finally { setSendBusy(false); }
  };
  const openPaymentLink = async (invoice: any) => {
    setLinkTarget(invoice); setPaymentLink(''); setLinkError(''); setLinkAsset(''); setLinkRecipient('');
    try { const response = await apiFetch('/api/integrations/near-intents/assets'); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Assets could not be loaded.'); const currency = invoice.currency.toUpperCase(); const eligible = (result.assets || []).filter((asset: any) => asset.symbol.toUpperCase() === currency || (currency === 'USD' && ['USDC', 'USDT'].includes(asset.symbol.toUpperCase()))); setLinkAssets(eligible); setLinkAsset(eligible[0]?.assetId || ''); if (!eligible.length) setLinkError(currency === 'USD' ? 'No supported USDC or USDT settlement asset is available.' : `No supported ${currency} settlement asset is available.`); }
    catch (error) { setLinkError(error instanceof Error ? error.message : 'Assets could not be loaded.'); }
  };
  const createPaymentLink = async (event: FormEvent) => { event.preventDefault(); if (!linkTarget) return; setLinkBusy(true); setLinkError(''); try { const response = await apiFetch(`/api/invoices/${linkTarget.id}/payment-link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentAssetId: linkAsset, paymentRecipient: linkRecipient.trim() }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Payment link could not be created.'); setPaymentLink(`${window.location.origin}${basePath}${result.paymentLink}`); qc.invalidateQueries({ queryKey: getGetInvoicesQueryKey() }); } catch (error) { setLinkError(error instanceof Error ? error.message : 'Payment link could not be created.'); } finally { setLinkBusy(false); } };
  return <AppFrame title="Invoices" eyebrow="CREATE AND RECEIVE INVOICES" action={canManageInvoices ? <button className="button button-green" onClick={() => void openNewInvoice()} data-testid="button-new-invoice"><Plus size={16} /> Create invoice</button> : undefined}>
    <div className="page-intro"><p>Create invoices here, then send them to a registered Veyra email. They appear in the recipient’s Received invoices dashboard; email only notifies them.</p><span className="intro-stamp"><FileText size={17} /> INVOICES</span></div>
    {notice && <div className="inline-notice notice-success"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    <div className="invoice-view-tabs" role="tablist" aria-label="Invoice direction">
      {canManageInvoices && <button type="button" role="tab" aria-selected={invoiceView === 'created'} className={invoiceView === 'created' ? 'invoice-view-tab active' : 'invoice-view-tab'} onClick={() => changeInvoiceView('created')}>Invoices I created <span>{list.data?.length || 0}</span></button>}
      <button type="button" role="tab" aria-selected={invoiceView === 'received'} className={invoiceView === 'received' ? 'invoice-view-tab active' : 'invoice-view-tab'} onClick={() => changeInvoiceView('received')}>Invoices sent to me <span>{receivedInvoices.length}</span></button>
    </div>
    {invoiceView === 'created' ? (list.isLoading ? <StatePanel kind="loading" title="Loading invoices" text="Your invoice records will be here shortly." /> : list.isError ? <StatePanel kind="error" title="Invoices did not load" text="Your invoice records are safe. Try loading them again." retry={() => list.refetch()} /> : !list.data?.length ? <EmptyState icon={<FileText size={22} />} title="No invoices yet." text="Create an invoice, then send it to the recipient’s verified Veyra email." action={<button className="button button-green" onClick={() => void openNewInvoice()}><Plus size={16} /> Create invoice</button>} /> : <div className="table-wrap"><table><thead><tr><th>INVOICE</th><th>RECIPIENT</th><th>DESCRIPTION</th><th>AMOUNT</th><th>DUE</th><th>STATUS</th><th>CREATED</th><th>ACTION</th></tr></thead><tbody>{list.data.map((item) => <tr key={item.id}><td><b className="record-number">{item.invoiceNumber}</b></td><td><span className="cell-primary">{item.clientEmail ? item.clientName : 'Not sent yet'}</span><small className="cell-secondary">{item.clientEmail || 'Add recipient when you send'}</small></td><td className="description-cell">{item.description}</td><td className="amount-cell">{formatDecimalAmount(item.currency, item.amount)}</td><td className="date-cell">{item.dueDate || '—'}</td><td><span className={`status-pill ${item.status === 'paid' ? 'status-success' : item.status === 'draft' ? 'status-draft' : 'status-pending'}`}><span />{item.status}</span></td><td className="date-cell">{formatDate(item.createdAt)}</td><td className="invoice-actions"><Link href={`/app/invoices/${item.id}`} className="button button-outline button-small">Details</Link>{item.status === 'draft' ? <button type="button" className="button button-green button-small" onClick={() => { setSendTarget(item); setSendEmail(item.clientEmail || ''); setSendError(''); }}>Send</button> : item.status === 'cancelled' ? null : item.publicToken ? <button type="button" className="button button-outline button-small" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${basePath}/pay/${item.publicToken}`)}>Copy link</button> : <button type="button" className="button button-outline button-small" onClick={() => void openPaymentLink(item)}>Set up link</button>}</td></tr>)}</tbody></table></div>    ) : receivedInvoicesLoading ? <StatePanel kind="loading" title="Loading received invoices" text="Checking invoices sent to your account." /> : receivedInvoicesError ? <StatePanel kind="error" title="Received invoices did not load" text={receivedInvoicesError} retry={() => void loadReceivedInvoices()} /> : !receivedInvoices.length ? <EmptyState icon={<FileText size={22} />} title="No invoices sent to you yet." text="Invoices addressed to your verified Veyra email will appear here. Email only notifies you; this dashboard keeps the invoice." action={<Link href="/app/invoices" className="button button-outline">View invoices I created</Link>} /> : <div className="table-wrap"><table><thead><tr><th>INVOICE</th><th>FROM</th><th>DESCRIPTION</th><th>AMOUNT DUE</th><th>DUE</th><th>STATUS</th><th>RECEIVED</th><th>ACTION</th></tr></thead><tbody>{receivedInvoices.map((item) => <tr key={item.id}><td><b className="record-number">{item.invoiceNumber}</b></td><td><span className="cell-primary">{item.senderName}</span></td><td className="description-cell">{item.description}</td><td className="amount-cell">{formatDecimalAmount(item.currency, item.amountDue || item.amount)}</td><td className="date-cell">{item.dueDate || '—'}</td><td><span className={`status-pill ${item.status === 'paid' ? 'status-success' : item.status === 'cancelled' ? 'status-muted' : 'status-pending'}`}><span />{item.status}</span></td><td className="date-cell">{formatDate(item.sentAt || item.createdAt)}</td><td className="invoice-actions">{item.publicToken && <Link href={`/pay/${item.publicToken}`} className="button button-green button-small">Open invoice <ArrowRight size={13} /></Link>}</td></tr>)}</tbody></table></div>}    <div className="honesty-note"><ShieldCheck size={18} /><span><b>Payment status follows settlement.</b> Veyra marks an invoice paid only after NEAR Intents confirms the transaction and the received asset, amount, and recipient match.</span></div>
    {modal && <Modal title="Create invoice" subtitle="Enter the invoice details and your receiving wallet. You’ll choose the registered Veyra recipient when you send it." onClose={() => setModal(false)}><form className="form-stack" onSubmit={submit}><label>Invoice summary<textarea name="description" required maxLength={2000} rows={2} placeholder="A short summary of this invoice" data-testid="input-invoice-description" /></label><div className="invoice-line-editor"><div className="invoice-line-heading"><b>Line items</b><button type="button" className="text-button" disabled={invoiceLines.length >= 30} onClick={() => setInvoiceLines((rows) => [...rows, { description: '', amount: '' }])}><Plus size={14} /> Add item</button></div>{invoiceLines.map((line, index) => <div className="invoice-line-fields" key={index}><label>Item description<input name="lineDescription" required maxLength={240} value={line.description} onChange={(event) => setInvoiceLines((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, description: event.target.value } : row))} placeholder="Design services" /></label><label>Amount<input name="lineAmount" required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={line.amount} onChange={(event) => setInvoiceLines((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, amount: event.target.value } : row))} placeholder="0.00" /></label>{invoiceLines.length > 1 && <button type="button" className="button button-outline button-small" aria-label={`Remove item ${index + 1}`} onClick={() => setInvoiceLines((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}><X size={14} /></button>}</div>)}</div><div className="form-pair"><label>Invoice total<input readOnly value={microsToDecimal(lineTotal)} aria-label="Calculated invoice total" /></label><label>Invoice currency<input name="currency" required minLength={3} maxLength={3} value={invoiceCurrency} onChange={(event) => { const currency = event.target.value.toUpperCase(); setInvoiceCurrency(currency); setInvoiceError(''); const matching = invoiceAssets.filter((asset) => asset.symbol.toUpperCase() === currency || (currency === 'USD' && ['USDC', 'USDT'].includes(asset.symbol.toUpperCase()))); setInvoiceAssetId((current) => matching.some((asset) => asset.assetId === current) ? current : matching[0]?.assetId || ''); }} data-testid="input-invoice-currency" /></label></div><label>Settlement asset<select required value={invoiceAssetId} disabled={invoiceAssetsLoading || compatibleInvoiceAssets.length === 0} onChange={(event) => setInvoiceAssetId(event.target.value)}><option value="">{invoiceAssetsLoading ? "Loading testnet assets…" : "Choose asset"}</option>{compatibleInvoiceAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()} testnet</option>)}</select></label>{!invoiceAssetsLoading && invoiceCurrency.length === 3 && compatibleInvoiceAssets.length === 0 && <p className="form-error">No matching testnet settlement asset is available for {invoiceCurrency}. Choose USD for supported USDC or USDT routes.</p>}{useCustomInvoiceRecipient ? <label>Other receiving wallet address<input required value={invoiceRecipient} onChange={(event) => setInvoiceRecipient(event.target.value)} maxLength={200} autoComplete="off" placeholder={selectedInvoiceAsset?.blockchain.toLowerCase() === "near" ? "name.testnet" : "0x…"} /></label> : <label>{selectedInvoiceAsset?.blockchain.toLowerCase() === "near" ? "Receiving NEAR testnet account" : "Receiving EVM testnet wallet address"}<input readOnly required value={defaultInvoiceRecipient} placeholder={selectedInvoiceAsset?.blockchain.toLowerCase() === "near" ? "Privy NEAR wallet is loading" : "Privy EVM wallet is loading"} /></label>}<button type="button" className="text-button" onClick={() => { if (!useCustomInvoiceRecipient) setInvoiceRecipient(''); setUseCustomInvoiceRecipient(!useCustomInvoiceRecipient); }}>{useCustomInvoiceRecipient ? 'Use my Privy wallet' : defaultInvoiceRecipient ? 'Use a different receiving address' : 'Enter a receiving address manually'}</button><p className="invoice-recipient-help">{useCustomInvoiceRecipient ? 'This address will receive the selected testnet settlement asset.' : 'Your Privy wallet is selected automatically. You can use another address if you prefer.'}</p><label>Due date <span className="optional-label">OPTIONAL</span><input type="date" name="dueDate" /></label><label>Payment terms <span className="optional-label">OPTIONAL</span><input name="paymentTerms" maxLength={1000} placeholder="Payment due within 14 days" /></label><label>Notes <span className="optional-label">OPTIONAL</span><textarea name="notes" maxLength={2000} rows={2} placeholder="Additional details for your client" /></label>{invoiceError && <p className="form-error" role="alert">{invoiceError}</p>}<div className="form-actions"><button type="button" className="button button-outline" onClick={() => setModal(false)}>Cancel</button><button className="button button-green" disabled={invoiceSaveBusy || invoiceAssetsLoading || lineTotal <= 0n}>{invoiceSaveBusy ? 'Creating invoice…' : 'Create invoice'} <ArrowRight size={15} /></button></div><p className="form-footnote">USD invoices can settle at the stated amount in USDC or USDT. Other currencies need a supported asset with the same currency.</p></form></Modal>}
    {sendTarget && <Modal title={"Send invoice " + sendTarget.invoiceNumber} subtitle="Enter the email used to register the recipient’s Veyra account." onClose={() => !sendBusy && setSendTarget(null)}><form className="form-stack" onSubmit={(event) => void sendInvoice(event)}><label>Recipient email<input type="email" required autoComplete="email" value={sendEmail} onChange={(event) => setSendEmail(event.target.value)} placeholder="recipient@example.com" /></label>{sendError && <p className="form-error" role="alert">{sendError}</p>}<p className="form-footnote">The invoice will appear in their Received invoices dashboard. Veyra will email a notification with a link back to the dashboard.</p><div className="form-actions"><button type="button" className="button button-outline" onClick={() => setSendTarget(null)} disabled={sendBusy}>Cancel</button><button className="button button-green" disabled={sendBusy}>{sendBusy ? 'Sending invoice…' : 'Send invoice'} <ArrowRight size={15} /></button></div></form></Modal>}{linkTarget && <Modal title={paymentLink ? 'Invoice and payment link ready' : `Finish payment setup for ${linkTarget.invoiceNumber}`} subtitle={paymentLink ? "Your invoice and payer checkout link were created together. Share this link with your client." : "This is for an older draft invoice. New invoices include payment setup in the same form."} onClose={() => setLinkTarget(null)}>{paymentLink ? <div className="form-stack"><label>Client checkout link<input readOnly value={paymentLink} /></label><p className="invoice-recipient-help">Give this link to your client. They will choose a testnet source asset and see the provider’s deposit address and any required memo. Your receiving wallet address is already attached to this invoice.</p><button className="button button-green" onClick={() => void navigator.clipboard.writeText(paymentLink)}>Copy client payment link <Copy size={15} /></button></div> : <form className="form-stack" onSubmit={createPaymentLink}><label>Settlement asset<select required value={linkAsset} onChange={(event) => setLinkAsset(event.target.value)}>{linkAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}</select></label><label>Receiving wallet address<input required value={linkRecipient} onChange={(event) => setLinkRecipient(event.target.value)} maxLength={200} autoComplete="off" /></label>{linkError && <p className="form-error">{linkError}</p>}<button className="button button-green" disabled={linkBusy || !linkAsset}>{linkBusy ? 'Creating link…' : 'Create payment link'} <ArrowRight size={15} /></button><p className="form-footnote">Share this link with your client. Checkout shows the provider deposit address and any required memo; your client does not send directly to your receiving address. The invoice amount and settlement currency stay fixed.</p></form>}</Modal>}
  </AppFrame>;
}

type InvoiceDetailView = {
  invoice: { id: string; invoiceNumber: string; clientName: string; clientEmail: string | null; description: string; lineItems: { description: string; amount: string }[]; amount: string; currency: string; status: string; dueDate: string | null; notes: string | null; paymentTerms: string | null; paymentAssetId: string | null; paymentRecipient: string | null; createdAt: string; sentAt: string | null; paidAt: string | null; paymentLink: string | null };
  paidAmount: string; remainingAmount: string;
  payments: { id: string; status: string; reconciliationStatus: string | null; originAssetSymbol: string | null; originAssetNetwork: string | null; destinationAssetSymbol: string | null; destinationAssetNetwork: string | null; quotedAmountIn: string | null; quotedAmountOut: string | null; actualAmountIn: string | null; actualAmountOut: string | null; refundedAmount: string | null; createdAt: string; settledAt: string | null; statusCheckedAt: string | null; lastError: string | null; explorerLinks: { label: string; url: string }[] }[];
};

function InvoiceDetailPage({ invoiceId }: { invoiceId: string }) {
  const [detail, setDetail] = useState<InvoiceDetailView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true); setError('');
    try {
      const response = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}/detail`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Invoice details could not be loaded.');
      setDetail(data as InvoiceDetailView);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Invoice details could not be loaded.'); }
    finally { setLoading(false); }
  }, [invoiceId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const copyPaymentLink = async () => {
    if (!detail?.invoice.paymentLink) return;
    const url = `${window.location.origin}${basePath}${detail.invoice.paymentLink}`;
    try { await navigator.clipboard.writeText(url); setNotice('Payment link copied.'); }
    catch { setError('Could not copy the payment link.'); }
  };
  const downloadInvoice = async () => {
    setDownloading(true); setError('');
    try {
      const response = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}/pdf`);
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Invoice PDF could not be downloaded.'); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `veyra-invoice-${detail?.invoice.invoiceNumber || invoiceId}.pdf`; anchor.click(); URL.revokeObjectURL(url);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Invoice PDF could not be downloaded.'); }
    finally { setDownloading(false); }
  };
  const sendReminder = async () => {
    if (!invoice?.clientEmail || !detail || Number(detail.remainingAmount) <= 0 || sendingReminder) return;
    setSendingReminder(true); setError(''); setNotice('');
    try {
      const response = await apiFetch(`/api/invoices/${encodeURIComponent(invoiceId)}/reminder`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'The invoice reminder could not be sent.');
      setNotice(`Payment reminder sent to ${body.recipientEmail}. It includes the current outstanding balance.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The invoice reminder could not be sent.'); }
    finally { setSendingReminder(false); }
  };
  const invoice = detail?.invoice;
  return <AppFrame title={invoice?.invoiceNumber || 'Invoice details'} eyebrow="INVOICE RECORD" action={<div className="invoice-detail-actions"><Link href="/app/invoices" className="button button-outline"><ArrowRight className="invoice-back-icon" size={15} /> All invoices</Link>{invoice && invoice.clientEmail && Number(detail?.remainingAmount || 0) > 0 && <button className="button button-green" onClick={() => void sendReminder()} disabled={sendingReminder}><Send size={15} /> {sendingReminder ? 'Sending reminder…' : 'Send reminder'}</button>}{invoice && <button className="button button-outline" onClick={() => void downloadInvoice()} disabled={downloading}><Download size={15} /> {downloading ? 'Preparing…' : 'Download invoice'}</button>}</div>}>
    {notice && <div className="inline-notice notice-success"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    {error && <div className="inline-notice notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
    {loading ? <StatePanel kind="loading" title="Loading invoice details" text="Checking the invoice and confirmed payment activity." /> : !detail || !invoice ? <StatePanel kind="error" title="Invoice details unavailable" text={error || 'This invoice could not be found in the current workspace.'} retry={() => void load()} /> : <div className="invoice-detail-page">
      <section className="invoice-detail-summary"><div className="invoice-detail-title"><span className="page-eyebrow">BILL TO</span><h2>{invoice.clientName}</h2><p>{invoice.clientEmail || 'Recipient has not been selected yet'}</p><span className={`status-pill ${invoice.status === 'paid' ? 'status-success' : invoice.status === 'draft' ? 'status-draft' : invoice.status === 'cancelled' ? 'status-muted' : 'status-pending'}`}><span />{invoice.status.replaceAll('_', ' ')}</span></div><div className="invoice-detail-totals"><div><small>INVOICE TOTAL</small><strong>{formatDecimalAmount(invoice.currency, invoice.amount)}</strong></div><div><small>CONFIRMED RECEIVED</small><strong>{formatDecimalAmount(invoice.currency, detail.paidAmount)}</strong></div><div><small>REMAINING</small><strong>{formatDecimalAmount(invoice.currency, detail.remainingAmount)}</strong></div></div></section>
      {invoice.paymentLink && <section className="invoice-detail-link"><div><b>Payment link</b><small>Share the existing link with the recipient.</small></div><div><a href={`${basePath}${invoice.paymentLink}`} target="_blank" rel="noreferrer" className="button button-outline button-small">Open checkout <ExternalLink size={13} /></a><button className="button button-green button-small" onClick={() => void copyPaymentLink()}><Copy size={14} /> Copy link</button></div></section>}
      <div className="invoice-detail-columns"><section className="invoice-detail-card"><div className="invoice-detail-card-heading"><span className="page-eyebrow">INVOICE DETAILS</span><h3>{invoice.description}</h3></div><div className="invoice-detail-facts"><div><small>Invoice number</small><b>{invoice.invoiceNumber}</b></div><div><small>Created</small><b>{formatDate(invoice.createdAt)}</b></div><div><small>Sent</small><b>{invoice.sentAt ? formatDate(invoice.sentAt) : 'Not sent'}</b></div><div><small>Due date</small><b>{invoice.dueDate || 'No due date'}</b></div><div><small>Payment terms</small><b>{invoice.paymentTerms || 'Not specified'}</b></div><div><small>Settlement asset</small><b>{invoice.paymentAssetId || 'Not configured'}</b></div><div className="invoice-detail-address"><small>Recipient wallet address</small><code>{invoice.paymentRecipient || 'Not configured'}</code></div></div>{invoice.notes && <div className="invoice-detail-notes"><small>Notes</small><p>{invoice.notes}</p></div>}<div className="invoice-detail-line-items"><h4>Line items</h4>{invoice.lineItems.map((line, index) => <div className="invoice-detail-line" key={`${index}-${line.description}`}><span>{line.description}</span><b>{formatDecimalAmount(invoice.currency, line.amount)}</b></div>)}<div className="invoice-detail-line invoice-detail-line-total"><b>Total</b><b>{formatDecimalAmount(invoice.currency, invoice.amount)}</b></div></div></section>
        <section className="invoice-detail-card invoice-payment-activity"><div className="invoice-detail-card-heading"><span className="page-eyebrow">PAYMENT ACTIVITY</span><h3>Payments and settlement</h3><p>Only provider-confirmed payments matched to this invoice count toward the received amount.</p></div>{detail.payments.length ? <div className="invoice-payment-list">{detail.payments.map((payment) => <article className="invoice-payment-item" key={payment.id}><div className="invoice-payment-top"><div><b>{payment.actualAmountOut || payment.quotedAmountOut ? `${payment.actualAmountOut || payment.quotedAmountOut} ${payment.destinationAssetSymbol || invoice.currency}` : 'Payment attempt'}</b><small>{payment.originAssetSymbol ? `Paid with ${payment.originAssetSymbol}${payment.originAssetNetwork ? ` · ${payment.originAssetNetwork}` : ''}` : 'Source asset unavailable'}</small><small>{payment.settledAt ? `Settled ${formatDate(payment.settledAt)}` : `Started ${formatDate(payment.createdAt)}`}</small></div><span className={`status-pill ${payment.status === 'SUCCESS' && payment.reconciliationStatus === 'matched_invoice' ? 'status-success' : payment.status === 'FAILED' || payment.status === 'REFUNDED' ? 'status-muted' : 'status-pending'}`}><span />{payment.status === 'SUCCESS' && payment.reconciliationStatus === 'matched_invoice' ? 'Confirmed for invoice' : payment.reconciliationStatus || payment.status.replaceAll('_', ' ').toLowerCase()}</span></div>{payment.actualAmountIn && <p className="invoice-payment-detail">Provider settled {payment.actualAmountIn} {payment.originAssetSymbol || ''}{payment.refundedAmount && Number(payment.refundedAmount) > 0 ? ` · ${payment.refundedAmount} refunded` : ''}</p>}{payment.lastError && <p className="invoice-payment-error">{payment.lastError}</p>}{payment.explorerLinks.length > 0 && <div className="invoice-payment-explorers">{payment.explorerLinks.map((link, index) => <a key={`${payment.id}-${index}`} href={link.url} target="_blank" rel="noreferrer">{link.label}<ExternalLink size={12} /></a>)}</div>}</article>)}</div> : <EmptyState icon={<Coins size={21} />} title="No payment attempts yet." text="When the recipient starts checkout, the quote and its confirmed settlement history will appear here." />}</section></div>
      <div className="honesty-note"><ShieldCheck size={18} /><span><b>Verified payment history.</b> The received total includes only payments the provider confirmed and Veyra matched to this invoice. A quote alone does not count as payment.</span></div>
    </div>}
  </AppFrame>;
}

type ReceivedInvoicePayable = { id: string; publicToken: string | null; invoiceNumber: string; senderName: string; description: string; amount: string; amountPaid?: string; amountDue?: string; pendingPayment?: { paymentId: string; txHash: string; submittedAt: string } | null; currency: string; dueDate: string | null; status: string; sentAt: string | null; createdAt: string };
type BillsToPayRow = { id: string; kind: 'invoice' | 'payroll'; reference: string; counterparty: string; description: string; amount: string; currency: string; dueDate: string | null; status: string; href: string };
type PayablePaymentAsset = { assetId: string; decimals: number; blockchain: string; symbol: string; contractAddress?: string | null };
type PreparedInvoicePayment = { invoice: ReceivedInvoicePayable; paymentId: string; quote: Record<string, unknown>; source: PayablePaymentAsset };

function BillsToPayPage() {
  const profile = useGetProfile({ query: { queryKey: getGetProfileQueryKey() } });
  const privy = usePrivyWallet();
  const [rows, setRows] = useState<BillsToPayRow[]>([]);
  const [receivedInvoices, setReceivedInvoices] = useState<ReceivedInvoicePayable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedInvoices, setSelectedInvoices] = useState<ReceivedInvoicePayable[]>([]);
  const [invoiceAssets, setInvoiceAssets] = useState<Record<string, PayablePaymentAsset[]>>({});
  const [invoiceSourceIds, setInvoiceSourceIds] = useState<Record<string, string>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMessage, setBatchMessage] = useState('');
  const [batchProgress, setBatchProgress] = useState('');
  const [preparedPayments, setPreparedPayments] = useState<PreparedInvoicePayment[]>([]);
  const batchSubmissionLock = useRef(false);
  const reload = async () => {
    setRefreshing(true); setError('');
    try {
      const includePayroll = profile.data?.workspaceType === 'business' && ['owner', 'admin'].includes(profile.data.role || '');
      const [invoiceResponse, payrollResponse] = await Promise.all([apiFetch('/api/received-invoices'), includePayroll ? apiFetch('/api/payroll/cycles') : Promise.resolve(null)]);
      const invoiceBody = await invoiceResponse.json(); const payrollBody = payrollResponse ? await payrollResponse.json() : [];
      if (!invoiceResponse.ok) throw new Error(invoiceBody.error || 'Received invoices could not be loaded.');
      if (payrollResponse && !payrollResponse.ok) throw new Error(payrollBody.error || 'Payroll obligations could not be loaded.');
      const invoices = (invoiceBody.invoices || []) as ReceivedInvoicePayable[];
      setReceivedInvoices(invoices.filter((invoice) => !['paid', 'cancelled'].includes(invoice.status) && Number(invoice.amountDue ?? invoice.amount) > 0 && !!invoice.publicToken));
      const invoiceRows: BillsToPayRow[] = invoices
        .filter((invoice) => !['paid', 'cancelled'].includes(invoice.status) && Number(invoice.amountDue ?? invoice.amount) > 0 && !!invoice.publicToken)
        .map((invoice) => ({ id: `invoice-${invoice.id}`, kind: 'invoice', reference: invoice.invoiceNumber, counterparty: invoice.senderName, description: invoice.description, amount: invoice.amountDue ?? invoice.amount, currency: invoice.currency, dueDate: invoice.dueDate, status: invoice.pendingPayment ? 'payment_submitted' : invoice.status, href: `/pay/${invoice.publicToken}` }));
      const payrollRows: BillsToPayRow[] = (payrollBody as PayrollCycleSummary[]).flatMap((cycle) => cycle.items
        .filter((item) => item.status !== 'paid')
        .map((item) => ({ id: `payroll-${item.id}`, kind: 'payroll', reference: `${cycle.frequency} payroll`, counterparty: item.employeeName, description: `Pay period ${cycle.periodStart}–${cycle.periodEnd}`, amount: item.payoutAmount || item.amount, currency: item.payoutAmount ? item.stablecoin : item.currency, dueDate: cycle.paymentDate, status: item.status, href: `/app/payroll#cycle-${cycle.id}` })));
      setRows([...invoiceRows, ...payrollRows].sort((a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31')));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Bills to pay could not be loaded.'); }
    finally { setLoading(false); setRefreshing(false); }
  };
  const checkSubmittedInvoice = async (invoice: ReceivedInvoicePayable) => {
    if (!invoice.publicToken || !invoice.pendingPayment) return;
    setRefreshing(true); setError('');
    try {
      const response = await apiFetch(`/api/public/invoices/${encodeURIComponent(invoice.publicToken)}/payments/${invoice.pendingPayment.paymentId}/status`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Payment status could not be checked.');
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Payment status could not be checked.'); }
    finally { setRefreshing(false); }
  };
  useEffect(() => { if (profile.data) void reload(); }, [profile.data?.workspaceType, profile.data?.role]);
  const invoiceCount = rows.filter((row) => row.kind === 'invoice').length;
  const payrollCount = rows.filter((row) => row.kind === 'payroll').length;
  const toggleInvoice = async (invoice: ReceivedInvoicePayable) => {
    setBatchMessage('');
    const exists = selectedInvoices.some((item) => item.id === invoice.id);
    const next = exists ? selectedInvoices.filter((item) => item.id !== invoice.id) : [...selectedInvoices, invoice];
    setSelectedInvoices(next); setPreparedPayments([]);
    if (exists) { setInvoiceSourceIds((current) => { const updated = { ...current }; delete updated[invoice.id]; return updated; }); return; }
    try {
      if (!invoice.publicToken) throw new Error(`${invoice.invoiceNumber} has no payment link.`);
      const response = await apiFetch(`/api/public/invoices/${encodeURIComponent(invoice.publicToken)}/assets`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Payment assets for ${invoice.invoiceNumber} could not be loaded.`);
      const assets = (body.assets || []) as PayablePaymentAsset[];
      setInvoiceAssets((current) => ({ ...current, [invoice.id]: assets }));
      const preferred = assets.find((asset) => asset.blockchain.toLowerCase() === 'near' && asset.symbol.toUpperCase() === 'WNEAR') || assets.find((asset) => asset.blockchain.toLowerCase() === 'near') || assets[0];
      if (preferred) setInvoiceSourceIds((current) => ({ ...current, [invoice.id]: preferred.assetId }));
      if (!assets.length) setBatchMessage(`No source assets are available for ${invoice.invoiceNumber}.`);
    } catch (cause) { setBatchMessage(cause instanceof Error ? cause.message : 'Payment assets could not be loaded.'); }
  };
  const prepareSelectedInvoices = async () => {
    if (selectedInvoices.length < 2 || batchSubmissionLock.current) return;
    batchSubmissionLock.current = true;
    setBatchBusy(true); setBatchMessage(''); setBatchProgress('');
    const created: PreparedInvoicePayment[] = [];
    try {
      for (const invoice of selectedInvoices) {
        const source = (invoiceAssets[invoice.id] || []).find((asset) => asset.assetId === invoiceSourceIds[invoice.id]);
        if (!source) throw new Error(`Choose a source asset for ${invoice.invoiceNumber}.`);
        const refundTo = source.blockchain.toLowerCase() === 'near' ? await connectNearWallet() : (privy.privyAuthenticated ? privy.privyAddress : '');
        if (!refundTo) throw new Error(source.blockchain.toLowerCase() === 'near' ? 'Your Privy NEAR wallet did not provide a refund address.' : 'Sign in to Veyra with Privy to pay from your EVM wallet.');
        if (!invoice.publicToken) throw new Error(`${invoice.invoiceNumber} has no payment link.`);
        const response = await apiFetch(`/api/public/invoices/${encodeURIComponent(invoice.publicToken)}/quotes`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ originAsset: source.assetId, refundTo, amount: invoice.amountDue || invoice.amount, slippageTolerance: 100 }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `A payment quote for ${invoice.invoiceNumber} could not be created.`);
        const quote = (body.quote?.quote || body.quote) as Record<string, unknown>;
        if (typeof body.paymentId !== 'string' || typeof quote?.depositAddress !== 'string' || typeof quote?.amountIn !== 'string' || !/^\d+$/.test(quote.amountIn)) throw new Error(`The provider returned incomplete payment instructions for ${invoice.invoiceNumber}.`);
        created.push({ invoice, paymentId: body.paymentId, quote, source });
      }
      setPreparedPayments(created);
      setBatchMessage(`Review all ${created.length} quotes below. No funds have moved yet.`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'Payment quotes could not be prepared.';
      if (created.length) {
        setPreparedPayments(created);
        setSelectedInvoices(created.map(({ invoice }) => invoice));
        setBatchMessage(`${detail} Quotes are ready for ${created.length} invoice${created.length === 1 ? '' : 's'}; only those invoices are included below. You can send them or choose the remaining invoices separately.`);
      } else setBatchMessage(detail);
    } finally { batchSubmissionLock.current = false; setBatchBusy(false); }
  };
  const sendPreparedInvoices = async () => {
    if (preparedPayments.length < 1 || preparedPayments.length !== selectedInvoices.length || batchSubmissionLock.current) return;
    batchSubmissionLock.current = true;
    setBatchBusy(true); setBatchMessage('');
    const submitted: string[] = [];
    let walletApproved = false;
    try {
      for (const [index, payment] of preparedPayments.entries()) {
        if (payment.source.blockchain.toLowerCase() === 'near') {
          const nearGroup = preparedPayments.filter((candidate) => candidate.source.assetId === payment.source.assetId);
          if (nearGroup[0]?.paymentId !== payment.paymentId) continue;
          // NEAR FT calls fit safely in groups of four; larger selections are
          // split into consecutive wallet approvals without limiting assets.
          for (let offset = 0; offset < nearGroup.length; offset += 4) {
            const chunk = nearGroup.slice(offset, offset + 4);
            const hashes = await sendNearDepositsBatch(payment.source, chunk.map(({ quote }) => ({ depositAddress: String(quote.depositAddress), amountIn: String(quote.amountIn), memo: typeof quote.depositMemo === 'string' ? quote.depositMemo : undefined })), {
              onRequesting: (requestIndex) => setBatchProgress(`Approve NEAR deposits for this group · transfer ${offset + requestIndex + 1} of ${nearGroup.length}…`),
              onSubmitted: (_, hash) => { if (hash) walletApproved = true; },
            });
            for (const [chunkIndex, sentPayment] of chunk.entries()) {
              const hash = hashes[chunkIndex];
              if (!hash) throw new Error(`${sentPayment.invoice.invoiceNumber} has no transaction reference. Check its status before retrying.`);
              submitted.push(`${sentPayment.invoice.invoiceNumber} (${hash})`);
              setSelectedInvoices((current) => current.filter((invoice) => invoice.id !== sentPayment.invoice.id));
              setPreparedPayments((current) => current.filter((item) => item.paymentId !== sentPayment.paymentId));
              const response = await apiFetch(`/api/public/invoices/${encodeURIComponent(sentPayment.invoice.publicToken!)}/payments/${sentPayment.paymentId}/near-deposit-submitted`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: hash }) });
              if (!response.ok) throw new Error(`${sentPayment.invoice.invoiceNumber} was sent (${hash}), but provider notification failed. Check its status.`);
            }
          }
        } else {
          const sentPayment = payment;
          setBatchProgress(`Approve payment ${index + 1} of ${preparedPayments.length} in Privy…`);
          const hash = await privy.sendPrivyDeposit(payment.source, String(payment.quote.depositAddress), String(payment.quote.amountIn));
          walletApproved = true;
          submitted.push(`${payment.invoice.invoiceNumber} (${hash})`);
          // Remove this quote immediately after its wallet transaction is
          // accepted, so later failures cannot offer a duplicate approval.
          setSelectedInvoices((current) => current.filter((invoice) => invoice.id !== sentPayment.invoice.id));
          setPreparedPayments((current) => current.filter((item) => item.paymentId !== sentPayment.paymentId));
          const response = await apiFetch(`/api/public/invoices/${encodeURIComponent(sentPayment.invoice.publicToken!)}/payments/${sentPayment.paymentId}/deposit-submitted`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: hash }) });
          if (!response.ok) throw new Error(`${sentPayment.invoice.invoiceNumber} was sent (${hash}), but provider notification failed. Check its status.`);
        }
      }
      setBatchMessage(`Submitted ${submitted.length} invoice payment${submitted.length === 1 ? '' : 's'} across the selected source assets. Check provider settlement.`);
      setSelectedInvoices([]); setPreparedPayments([]); setInvoiceSourceIds({}); await reload();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'The selected invoices could not be paid.';
      const remaining = Math.max(0, preparedPayments.length - submitted.length);
      setBatchMessage(walletApproved ? `${detail} Do not approve invoices already sent. Refresh Bills to pay or open each invoice to check settlement.${remaining ? ` ${remaining} unsent invoice${remaining === 1 ? '' : 's'} remain available.` : ''}` : detail);
      if (walletApproved && remaining === 0) { setSelectedInvoices([]); setPreparedPayments([]); setInvoiceSourceIds({}); }
    } finally { batchSubmissionLock.current = false; setBatchBusy(false); setBatchProgress(''); }
  };
  return <AppFrame title="Bills to pay" eyebrow="INVOICES AND PAYROLL" action={<button className="button button-outline" onClick={() => void reload()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh list'}</button>}>
    <div className="page-intro"><p>This list is built automatically from invoices sent to your account and payroll you prepare. There is no separate bill to add.</p><span className="intro-stamp"><FileText size={17} /> YOUR OUTSTANDING PAYMENTS</span></div>
    {error && <div className="inline-notice notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
    {batchMessage && <div className={`inline-notice ${batchMessage.startsWith('Submitted') || batchMessage.startsWith('Review all') ? 'notice-success' : 'notice-error'}`} role="status"><span>{batchMessage}</span><button onClick={() => setBatchMessage('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    {selectedInvoices.length > 0 && <section className="payables-batch-bar"><div><b>{selectedInvoices.length} invoices selected</b><span>Choose a source asset for each invoice. Recipient asset and chain stay fixed by the invoice.</span>{selectedInvoices.map((invoice) => <label key={invoice.id} className="payables-batch-source"><span>{invoice.invoiceNumber}</span><select aria-label={`Source asset for ${invoice.invoiceNumber}`} value={invoiceSourceIds[invoice.id] || ''} onChange={(event) => { setInvoiceSourceIds((current) => ({ ...current, [invoice.id]: event.target.value })); setPreparedPayments([]); }}>{(invoiceAssets[invoice.id] || []).map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain.toUpperCase()}</option>)}</select></label>)}</div><button className="button button-green" onClick={() => void prepareSelectedInvoices()} disabled={batchBusy || selectedInvoices.length < 2 || selectedInvoices.some((invoice) => !(invoiceAssets[invoice.id] || []).some((asset) => asset.assetId === invoiceSourceIds[invoice.id])) || preparedPayments.length > 0}>{batchBusy ? 'Preparing quotes…' : preparedPayments.length ? 'Quotes ready to review' : `Prepare ${selectedInvoices.length} payment quotes`}</button><button className="button button-outline" onClick={() => { setSelectedInvoices([]); setPreparedPayments([]); setInvoiceSourceIds({}); setBatchMessage(''); }} disabled={batchBusy}>Clear selection</button></section>}
    {preparedPayments.length > 0 && <section className="payables-batch-review"><div><span className="page-eyebrow">REVIEW EACH PAYMENT</span><h2>{preparedPayments.length} invoice quotes are ready</h2><p>No funds have moved. Check each amount, source asset, and recipient invoice before approving.</p></div><div className="payables-batch-review-list">{preparedPayments.map(({ invoice, quote, source }) => <article key={invoice.id}><div><b>{invoice.invoiceNumber} · {invoice.senderName}</b><small>{invoice.description}</small></div><span><small>YOU SEND · {source.symbol} · {source.blockchain.toUpperCase()}</small><b>{String(quote.amountInFormatted || quote.amountIn)} {source.symbol}</b></span><ArrowRight size={16} /><span><small>INVOICE RECEIVES · ESTIMATE</small><b>{String(quote.amountOutFormatted || quote.amountOut)} {invoice.currency}</b></span></article>)}</div><div className="payables-batch-review-actions"><button className="button button-outline" onClick={() => { setPreparedPayments([]); setBatchMessage('Quotes cleared. No funds moved.'); }} disabled={batchBusy}>Discard quotes</button><button className="button button-green" onClick={() => void sendPreparedInvoices()} disabled={batchBusy}>{batchBusy ? (batchProgress || 'Waiting for wallet approval…') : 'Approve invoice payments'}</button></div></section>}
    <div className={`payables-source-cards ${profile.data?.workspaceType === 'business' && ['owner', 'admin'].includes(profile.data.role || '') ? '' : 'payables-source-cards-single'}`}><Link href="/app/invoices?tab=received" className="payables-source-card"><span className="page-eyebrow">RECEIVED INVOICES</span><strong>{invoiceCount}</strong><span>Invoices addressed to this Veyra account</span></Link>{profile.data?.workspaceType === 'business' && ['owner', 'admin'].includes(profile.data.role || '') && <Link href="/app/payroll" className="payables-source-card"><span className="page-eyebrow">PAYROLL PAYMENTS</span><strong>{payrollCount}</strong><span>Employee payments from prepared pay runs</span></Link>}</div>
    {loading || !profile.data ? <StatePanel kind="loading" title="Gathering what is due" text="Checking invoices addressed to your account." /> : error ? <StatePanel kind="error" title="Payables did not load" text={error} retry={() => void reload()} /> : rows.length === 0 ? <EmptyState icon={<FileText size={22} />} title="Nothing to pay right now." text="When a Veyra account sends you an invoice, it appears here. Businesses also see employee payments from prepared payroll." action={<div className="empty-actions"><Link href="/app/invoices?tab=received" className="button button-outline">View received invoices</Link>{profile.data.workspaceType === 'business' && ['owner', 'admin'].includes(profile.data.role || '') && <Link href="/app/payroll" className="button button-green">Open payroll</Link>}</div>} /> : <div className="table-wrap"><table><thead><tr><th>SELECT</th><th>SOURCE</th><th>PAY TO</th><th>DETAIL</th><th>AMOUNT DUE</th><th>DUE</th><th>STATUS</th><th>ACTION</th></tr></thead><tbody>{rows.map((row) => { const invoice = row.kind === 'invoice' ? receivedInvoices.find((item) => `invoice-${item.id}` === row.id) : undefined; const submitted = !!invoice?.pendingPayment; return <tr key={row.id}><td>{invoice ? submitted ? '—' : <input type="checkbox" aria-label={`Select invoice ${invoice.invoiceNumber} for batch payment`} checked={selectedInvoices.some((item) => item.id === invoice.id)} disabled={batchBusy} onChange={() => void toggleInvoice(invoice)} /> : '—'}</td><td><span className={`status-pill ${row.kind === 'invoice' ? 'status-pending' : 'status-draft'}`}><span />{row.kind === 'invoice' ? 'Invoice' : 'Payroll'}</span><small className="cell-secondary">{row.reference}</small></td><td><span className="cell-primary">{row.counterparty}</span></td><td className="description-cell">{row.description}</td><td className="amount-cell">{formatDecimalAmount(row.currency, row.amount)}</td><td className="date-cell">{row.dueDate || '—'}</td><td><span className={`status-pill ${submitted || row.status === 'pending_settlement' || row.status === 'processing' ? 'status-pending' : row.status === 'failed' ? 'status-error' : 'status-draft'}`}><span />{submitted ? 'payment submitted · awaiting settlement' : row.status.replace(/_/g, ' ')}</span></td><td>{submitted && invoice ? <button className="button button-outline button-small" onClick={() => void checkSubmittedInvoice(invoice)} disabled={refreshing}>{refreshing ? 'Checking…' : 'Check status'} <RefreshCw size={13} /></button> : <Link className="button button-green button-small" href={row.href}>{row.kind === 'invoice' ? 'Review & pay' : 'Open pay run'} <ArrowRight size={13} /></Link>}</td></tr>; })}</tbody></table></div>}
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>One list, existing records.</b> Received invoices and prepared payroll create these amounts due. Select multiple invoices and choose a source asset per invoice; each transfer needs wallet approval and provider settlement confirmation.</span></div>
  </AppFrame>;
}
function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><span className="page-eyebrow">A CLEAN SLATE</span><h2>{title}</h2><p>{text}</p>{action}</div>;
}
function formatDate(date: string) { return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
async function downloadPrivateFile(path: string, filename: string) {
  const response = await apiFetch(path);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'The file could not be downloaded.'); }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function formatDecimalAmount(currency: string, amount: string) {
  const [whole, fraction] = amount.split('.');
  const groupedWhole = BigInt(whole || '0').toLocaleString();
  const visibleFraction = (fraction || '').slice(0, 6).replace(/0+$/, '').padEnd(2, '0');
  return `${currency} ${groupedWhole}.${visibleFraction}`;
}

function PayrollRoutePage() {
  const profile = useGetProfile({ query: { queryKey: getGetProfileQueryKey() } });
  if (profile.isLoading) return <AppFrame title="Organization" eyebrow="ORGANIZATION WORKSPACE"><StatePanel kind="loading" title="Checking workspace" text="Loading your organization team and pay tools." /></AppFrame>;
  if (profile.data?.workspaceType !== 'business') return <OrganizationDirectory nextPath="/app/payroll" />;
  if (!['owner', 'admin'].includes(profile.data?.role || '')) return <AppFrame title="Organization" eyebrow="ORGANIZATION WORKSPACE"><EmptyState icon={<Users size={22} />} title="Payroll administration is for organization owners and admins." text="You can still receive invoices and review your own organization pay from the Organization page." action={<Link href="/app/organization" className="button button-green">Open organization</Link>} /></AppFrame>;
  return <PayrollPage organizationName={profile.data.workspaceName || 'Organization'} />;
}

function OrganizationRoutePage() {
  const profile = useGetProfile({ query: { queryKey: getGetProfileQueryKey() } });
  if (profile.isLoading) return <AppFrame title="Organization" eyebrow="YOUR ORGANIZATION"><StatePanel kind="loading" title="Opening your organization" text="Loading your team workspace." /></AppFrame>;
  if (profile.data?.workspaceType === 'business' && profile.data.role === 'employee') return <EmployeePortalPage />;
  if (profile.data?.workspaceType === 'business' && ['owner', 'admin'].includes(profile.data.role || '')) return <PayrollPage organizationName={profile.data.workspaceName || 'Organization'} />;
  return <OrganizationDirectory nextPath="/app/organization" />;
}

function OrganizationDirectory({ nextPath }: { nextPath: string }) {
  const memberships = useListWorkspaces();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const organizations = (memberships.data?.workspaces || []).filter((workspace) => workspace.type === 'business');
  const openOrganization = async (workspaceId: string) => {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
    await queryClient.invalidateQueries();
    navigate(nextPath);
  };

  return <AppFrame title="Your organizations" eyebrow="ORGANIZATION WORKSPACES" action={<Link href="/app/organization/new" className="button button-green"><Plus size={15} /> Create organization</Link>}>
    <div className="page-intro"><p>Each organization has its own team, invoices, pay runs, and records. Switch between them without changing your personal workspace.</p><span className="intro-stamp"><Users size={16} /> YOUR TEAMS</span></div>
    {memberships.isLoading ? <StatePanel kind="loading" title="Finding your organizations" text="Loading the teams available to this account." /> : memberships.isError ? <StatePanel kind="error" title="Organizations could not load" text="Your memberships are safe. Try again." retry={() => void memberships.refetch()} /> : organizations.length === 0 ? <EmptyState icon={<Users size={22} />} title="Start an organization workspace." text="Create a team workspace for your business. Your personal workspace and its records will stay separate." action={<Link href="/app/organization/new" className="button button-green"><Plus size={15} /> Create organization</Link>} /> : <section className="organization-directory-list" aria-label="Organizations you belong to">{organizations.map((workspace) => <article className="organization-directory-card" key={workspace.id}><span className="organization-directory-icon"><Users size={19} /></span><div className="organization-directory-copy"><span className="page-eyebrow">ORGANIZATION · {workspace.role.toUpperCase()}</span><h2>{workspace.name}</h2><p>{workspace.role === 'employee' ? 'Team membership and your pay information' : 'Team, invoices, payroll, and financial records'}</p></div><button type="button" className="button button-outline" onClick={() => void openOrganization(workspace.id)}>Open workspace <ArrowRight size={15} /></button></article>)}</section>}
    <p className="organization-directory-footnote">Your personal workspace remains available from the workspace switcher.</p>
  </AppFrame>;
}

function CreateOrganizationPage() {
  const create = useCreateWorkspace();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate({ data: { name: name.trim(), type: 'business' } }, {
      onSuccess: async (workspace) => {
        if (!workspace.workspaceId) return;
        localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.workspaceId);
        await queryClient.invalidateQueries();
        navigate('/app/organization');
      },
    });
  };

  return <AppFrame title="Create organization" eyebrow="NEW TEAM WORKSPACE">
    <div className="organization-create-layout"><section className="panel-card organization-create-card"><span className="organization-create-icon"><Users size={22} /></span><span className="page-eyebrow">YOUR TEAM, IN ITS OWN SPACE</span><h2>Set up your organization.</h2><p>Invite people, keep organization invoices together, and prepare team pay runs from this workspace.</p><form className="form-stack" onSubmit={submit}><label>Organization name<input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Ada Studio" autoFocus /></label>{create.isError && <p className="form-error" role="alert">{create.error instanceof Error ? create.error.message : 'The organization workspace could not be created. Try again.'}</p>}<div className="form-actions"><Link href="/app" className="button button-outline">Cancel</Link><button className="button button-green" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create organization'} <ArrowRight size={15} /></button></div></form></section><aside className="organization-create-note"><span className="page-eyebrow">YOUR WORKSPACES STAY SEPARATE</span><h3>Your personal workspace remains yours.</h3><p>Creating an organization gives it a separate team, role access, invoices, and payroll. You can switch between this organization and your personal workspace at any time.</p></aside></div>
  </AppFrame>;
}

type EmployeeRosterRecord = {
  id: string; userId: string | null; name: string; email: string; country: string; position: string;
  compensationAmount: string; compensationCurrency: string; payFrequency: 'weekly' | 'biweekly' | 'monthly';
  preferredStablecoin: string; preferredNetwork: string; walletAddress: string | null;
  payrollEnabled: boolean; payoutProfileCompleted: boolean;
};

function PayrollPage({ organizationName }: { organizationName: string }) {
  const privy = usePrivyWallet();
  const list = useGetEmployees({ query: { queryKey: getGetEmployeesQueryKey() } });
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [inviteModal, setInviteModal] = useState(false);
  const [notice, setNotice] = useState('');
  const [inviteBusy, setInviteBusy] = useState('');
  const [payrollCycles, setPayrollCycles] = useState<PayrollCycleSummary[]>([]);
  const [cycleBusy, setCycleBusy] = useState(false);
  const [cycleFrequency, setCycleFrequency] = useState<'weekly' | 'biweekly' | 'monthly'>('monthly');
  const [cycleStart, setCycleStart] = useState(new Date().toISOString().slice(0, 10));
  const [cycleEnd, setCycleEnd] = useState(new Date().toISOString().slice(0, 10));
  const [cyclePayDate, setCyclePayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payoutTarget, setPayoutTarget] = useState<{ cycleId: string; item: PayrollCycleSummary['items'][number] } | null>(null);
  const [batchTarget, setBatchTarget] = useState<PayrollCycleSummary | null>(null);
  const [payoutAssets, setPayoutAssets] = useState<PayrollAsset[]>([]);
  const [payoutSource, setPayoutSource] = useState('');
  const [payoutRefundTo, setPayoutRefundTo] = useState('');
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutError, setPayoutError] = useState('');
  const ownerAddressForAsset = async (asset: PayrollAsset) => {
    if (asset.blockchain.toLowerCase() === 'near') {
      const address = await resolveNearOwnerTestnetAccount();
      if (!address) throw new Error('Sign in to Veyra before preparing owner-wallet payouts.');
      return address;
    }
    if (!getEvmChainId(asset.blockchain)) throw new Error(`Owner wallet payments are not available on ${asset.blockchain} yet.`);
    if (!privy.privyAddress) throw new Error('Your Privy owner wallet is still loading. Retry in a moment.');
    return privy.privyAddress;
  };
  const changeBatchSource = async (assetId: string) => {
    const asset = payoutAssets.find((candidate) => candidate.assetId === assetId);
    if (!asset) return;
    setPayoutSource(assetId); setPayoutRefundTo(''); setPayoutError(''); setPayoutBusy(true);
    try { setPayoutRefundTo(await ownerAddressForAsset(asset)); }
    catch (error) { setPayoutError(error instanceof Error ? error.message : 'Your owner wallet could not be loaded.'); }
    finally { setPayoutBusy(false); }
  };
  const openBatchPayout = async (cycle: PayrollCycleSummary) => {
    setNotice(''); setPayoutError(''); setPayoutBusy(true);
    try {
      const response = await apiFetch('/api/integrations/near-intents/assets', { credentials: 'include' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Supported payout assets could not be loaded.');
      const assets = body.assets as PayrollAsset[];
      setPayoutAssets(assets);
      const source = assets.find((asset) => asset.blockchain.toLowerCase() === 'near' && asset.symbol.toUpperCase() === 'WNEAR') || assets.find((asset) => asset.blockchain.toLowerCase() === 'near') || assets[0];
      setPayoutSource(source?.assetId || '');
      if (source) setPayoutRefundTo(await ownerAddressForAsset(source));
      setBatchTarget(cycle);
    } catch (error) { const message = error instanceof Error ? error.message : 'Supported payout assets could not be loaded.'; setPayoutError(message); setNotice(message); }
    finally { setPayoutBusy(false); }
  };
  const prepareAllPayouts = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!batchTarget) return;
    setPayoutBusy(true); setPayoutError(''); setNotice('');
    const items = batchTarget.items.filter((item) => item.status === 'queued' || item.status === 'failed');
    let prepared = 0; const errors: string[] = [];
    try {
      for (const item of items) {
        try {
          const response = await apiFetch(`/api/payroll/items/${item.id}/quote`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ originAsset: payoutSource, refundTo: payoutRefundTo.trim() }) });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || 'Quote could not be prepared.');
          prepared += 1;
        } catch (error) { errors.push(`${item.employeeName}: ${error instanceof Error ? error.message : 'Quote failed'}`); }
      }
      setBatchTarget(null);
      setNotice(`${prepared} of ${items.length} payout quotes prepared.${errors.length ? ` Needs attention: ${errors.join(' · ')}` : ' Review the team totals, then choose Pay all to send from your connected wallet.'}`);
      await loadCycles();
    } finally { setPayoutBusy(false); }
  };
  const [employeeToEdit, setEmployeeToEdit] = useState<(EmployeeRosterRecord & { id: string; payrollEnabled?: boolean; payoutProfileCompleted?: boolean; userId?: string | null }) | null>(null);
  const [employeeSaveBusy, setEmployeeSaveBusy] = useState(false);
  const [employeeSaveError, setEmployeeSaveError] = useState('');
  const payrollReadyCount = (list.data as (EmployeeRosterRecord & { payrollEnabled?: boolean; payoutProfileCompleted?: boolean })[] | undefined)?.filter((person) => person.payrollEnabled && person.payoutProfileCompleted).length || 0;
  const loadCycles = async () => { try { const response = await apiFetch('/api/payroll/cycles', { credentials: 'include' }); if (!response.ok) throw new Error(); setPayrollCycles(await response.json()); } catch { setNotice('Payroll cycle history could not be loaded.'); } };
  const openPayout = async (cycleId: string, item: PayrollCycleSummary['items'][number]) => {
    setNotice(''); setPayoutError(''); setPayoutBusy(true);
    try { const response = await apiFetch('/api/integrations/near-intents/assets', { credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Supported payout assets could not be loaded.'); const assets = body.assets as PayrollAsset[]; setPayoutAssets(assets); const destination = assets.find((asset) => asset.symbol.toUpperCase() === item.stablecoin.toUpperCase() && asset.blockchain.toLowerCase() === item.network.toLowerCase()); const sources = assets.filter((asset) => asset.assetId !== destination?.assetId); const source = sources.find((asset) => asset.blockchain.toLowerCase() === 'near' && asset.symbol.toUpperCase() === 'WNEAR') || sources.find((asset) => asset.blockchain.toLowerCase() === 'near') || sources[0]; setPayoutSource(source?.assetId || ''); if (source) setPayoutRefundTo(await ownerAddressForAsset(source)); setPayoutTarget({ cycleId, item }); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Supported payout assets could not be loaded.'); }
    finally { setPayoutBusy(false); }
  };
  const preparePayout = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!payoutTarget) return; setPayoutBusy(true); setNotice('');
    try {
      const response = await apiFetch(`/api/payroll/items/${payoutTarget.item.id}/quote`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ originAsset: payoutSource, refundTo: payoutRefundTo.trim() }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'The payout quote could not be prepared.');
      setPayoutTarget(null); setNotice(`Signed payout quote ready for ${payoutTarget.item.employeeName}. No funds have moved yet. Follow the quoted deposit instructions, then check its provider status.`); await loadCycles();
    } catch (error) { const message = error instanceof Error ? error.message : 'The payout quote could not be prepared.'; setPayoutError(message); setNotice(message); }
    finally { setPayoutBusy(false); }
  };
  const checkPayout = async (item: PayrollCycleSummary['items'][number]) => {
    setCycleBusy(true); setNotice('');
    try { const response = await apiFetch(`/api/payroll/items/${item.id}/status`, { method: 'POST', credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Provider status could not be checked.'); setNotice(body.reconciliationStatus === 'matched_payroll' ? `Provider confirmed ${item.employeeName}'s payroll payment.` : body.status === 'SUCCESS' ? `The provider settled ${item.employeeName}'s payment, but it did not match the approved payroll details. Review the payment record.` : `Provider status for ${item.employeeName}: ${body.status}.`); await loadCycles(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Provider status could not be checked.'); }
    finally { setCycleBusy(false); }
  };
  const sendPayrollBatch = async (items: PayrollCycleSummary['items'][number][]) => {
    setCycleBusy(true); setNotice(''); let notified = 0; let attempted = 0;
    try {
      const response = await apiFetch('/api/integrations/near-intents/assets'); const catalog = await response.json();
      if (!response.ok) throw new Error(catalog.error || 'Supported assets could not be loaded.');
      const first = items[0]; const symbol = first?.paymentQuote?.originAssetSymbol; const network = first?.paymentQuote?.originAssetNetwork;
      if (!symbol || !network) throw new Error('Choose prepared quotes that use the same source asset to pay this group.');
      const asset = (catalog.assets as PayrollAsset[]).find((candidate) => candidate.symbol === symbol && candidate.blockchain === network);
      if (!asset) throw new Error('The source asset is no longer supported. Prepare fresh quotes.');
      const batch = items.filter((item) => item.paymentQuote?.originAssetSymbol === symbol && item.paymentQuote?.originAssetNetwork === network && item.status === 'pending_settlement' && item.paymentQuote.reconciliationStatus !== 'unmatched_payroll');
      const deposits = batch.map((item) => { const quote = payrollQuoteDetails(item.paymentQuote?.quote); return { item, depositAddress: String(quote.depositAddress || ''), amountIn: String(quote.amountIn || ''), memo: typeof quote.depositMemo === 'string' ? quote.depositMemo : undefined }; });
      if (deposits.some((deposit) => !deposit.depositAddress || !deposit.amountIn)) throw new Error('A saved quote is missing deposit details. Prepare a fresh quote for that employee.');
      setNotice(`Paying ${batch.length} team members from your connected wallet. Approve each wallet request to continue.`);
      const isNear = network.toLowerCase() === 'near';
      if (!isNear && !getEvmChainId(network)) throw new Error('This source network cannot be sent from the connected wallet yet.');
      const notify = async (index: number, hash?: string) => {
        if (!hash) return;
        attempted += 1;
        const item = deposits[index]!.item;
        try { const result = await apiFetch(`/api/payroll/items/${item.id}/${isNear ? 'near-deposit-submitted' : 'deposit-submitted'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: hash }) }); if (result.ok) notified += 1; } catch { /* The signed wallet transfer remains visible in the individual payment details. */ }
      };
      if (isNear) {
        await sendNearDepositsBatch(asset, deposits.map(({ depositAddress, amountIn, memo }) => ({ depositAddress, amountIn, memo })), {
          onRequesting: (index, total) => setNotice(`Wallet approval ${Math.floor(index / 4) + 1} of ${Math.ceil(total / 4)} · paying ${total} team members…`),
          onSubmitted: notify,
        });
      } else {
        for (const [index, { depositAddress, amountIn }] of deposits.entries()) {
          setNotice(`Wallet approval ${index + 1} of ${deposits.length} · paying ${deposits.length} team members…`);
          await notify(index, await privy.sendPrivyDeposit(asset, depositAddress, amountIn));
        }
      }
      setNotice(`${notified} of ${deposits.length} wallet transfers were recorded with the provider.${notified < deposits.length ? ` ${attempted} wallet transfer${attempted === 1 ? '' : 's'} were submitted; check individual payments for the rest.` : ' Check the pay run for provider settlement updates.'}`); await loadCycles();
    } catch (error) { const detail = error instanceof Error ? error.message : 'The payroll batch could not be sent.'; setNotice(attempted ? `${detail} ${attempted} transfer(s) were already submitted and recorded; review the pay run before retrying.` : detail); await loadCycles(); }
    finally { setCycleBusy(false); }
  };
  useEffect(() => { void loadCycles(); }, []);
  const prepareCycle = async () => {
    setCycleBusy(true); setNotice('');
    try { const idempotencyKey = crypto.randomUUID(); const response = await apiFetch('/api/payroll/cycles/prepare', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frequency: cycleFrequency, periodStart: cycleStart, periodEnd: cycleEnd, paymentDate: cyclePayDate, idempotencyKey }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not prepare payroll.'); setNotice(`Payroll review prepared for ${body.items.length} employees. No payments have been initiated.`); await loadCycles(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not prepare payroll.'); }
    finally { setCycleBusy(false); }
  };
  const approveCycle = async (cycleId: string) => {
    setCycleBusy(true); setNotice('');
    try { const response = await apiFetch(`/api/payroll/cycles/${cycleId}/approve`, { method: 'POST', credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not approve payroll.'); setNotice(body.message); await loadCycles(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not approve payroll.'); }
    finally { setCycleBusy(false); }
  };
  const refreshDraftCycle = async (cycleId: string) => {
    setCycleBusy(true); setNotice('');
    try { const response = await apiFetch(`/api/payroll/cycles/${cycleId}/refresh`, { method: 'POST', credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'This draft could not be refreshed.'); setNotice(body.message); await loadCycles(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'This draft could not be refreshed.'); }
    finally { setCycleBusy(false); }
  };
  const discardDraftCycle = async (cycle: PayrollCycleSummary) => {
    if (!window.confirm(`Discard this unapproved ${cycle.frequency} pay run for ${cycle.periodStart}–${cycle.periodEnd}? No payments have been sent.`)) return;
    setCycleBusy(true); setNotice('');
    try { const response = await apiFetch(`/api/payroll/cycles/${cycle.id}`, { method: 'DELETE', credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'This draft could not be discarded.'); setNotice('Unapproved pay run discarded. No funds moved.'); await loadCycles(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'This draft could not be discarded.'); }
    finally { setCycleBusy(false); }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!employeeToEdit || employeeSaveBusy) return; const f = new FormData(event.currentTarget);
    const data = { employeeId: employeeToEdit.id, compensationAmount: String(f.get('amount')).trim(), compensationCurrency: String(f.get('currency')).toUpperCase(), payFrequency: String(f.get('frequency')) };
    const path = employeeToEdit.payrollEnabled ? `/api/employees/${employeeToEdit.id}` : '/api/employees';
    const method = employeeToEdit.payrollEnabled ? 'PATCH' : 'POST';
    setEmployeeSaveBusy(true); setEmployeeSaveError(''); setNotice('');
    try {
      const response = await apiFetch(path, { method, credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(25_000) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Payroll details could not be saved.');
      await Promise.all([
        qc.invalidateQueries({ queryKey: getGetEmployeesQueryKey() }),
        qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
        qc.invalidateQueries({ queryKey: getGetRecordsQueryKey() }),
      ]);
      const employeeName = employeeToEdit.name;
      const wasOnPayroll = employeeToEdit.payrollEnabled;
      setModal(false); setEmployeeToEdit(null);
      setNotice(wasOnPayroll ? `${employeeName}’s payroll details were updated. Approved pay runs were not changed.` : `${employeeName} was added to payroll. Their pay details are saved and they’ll appear in the next pay run.`);
    } catch (error) {
      setEmployeeSaveError(error instanceof Error ? error.message : 'Payroll details could not be saved. Please try again.');
    } finally { setEmployeeSaveBusy(false); }
  };
  const removeEmployee = async (person: EmployeeRosterRecord & { id: string; name: string }) => {
    if (!window.confirm(`Remove ${person.name} from the employee list? Saved payroll history will remain.`)) return;
    try { const response = await apiFetch(`/api/employees/${person.id}`, { method: 'DELETE', credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not remove the employee.'); qc.invalidateQueries({ queryKey: getGetEmployeesQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getGetRecordsQueryKey() }); setNotice(`${person.name} was removed from the active employee list. Existing payroll history remains.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not remove the employee.'); }
  };
  const inviteEmployee = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setInviteBusy('new'); setNotice('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await apiFetch('/api/employees/invitations', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: String(form.get('name')).trim(), email: String(form.get('email')).trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The team invitation could not be sent.');
      setInviteModal(false); qc.invalidateQueries({ queryKey: getGetEmployeesQueryKey() });
      setNotice(`Invitation sent to ${body.email}. If they already use Veyra, they can sign in with this email. New users can create an account from the invitation. Both can save a payout wallet before you add them to payroll.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The employee invitation could not be created.'); }
    finally { setInviteBusy(''); }
  };
  const resendInvitation = async (person: EmployeeRosterRecord & { id: string; name: string }) => {
    setInviteBusy(person.id); setNotice('');
    try { const response = await apiFetch(`/api/employees/${person.id}/invitation`, { method: 'POST' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'The invitation could not be resent.'); setNotice(`A fresh invitation was emailed to ${body.email}.`); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'The invitation could not be resent.'); }
    finally { setInviteBusy(''); }
  };
  return <AppFrame title={organizationName} eyebrow="ORGANIZATION WORKSPACE · TEAM AND PAY" action={<div className="payroll-actions"><button className="button button-green" onClick={() => { setNotice(''); setInviteModal(true); }} data-testid="button-invite-team-member"><Plus size={16} /> Invite team member</button></div>}>
    <div className="page-intro"><p>Manage your organization’s team here. Invite members first; once they save their payout wallet, set their pay and prepare a pay run.</p><span className="intro-stamp"><Users size={17} /> ORGANIZATION TEAM</span></div>
    <section className="payroll-workflow-guide" aria-label="How to pay your team">
      <div className="payroll-workflow-heading"><span className="page-eyebrow">FROM INVOICE INCOME TO PAYROLL</span><h2>How a business pays its team</h2><p>Invoice income goes to the receiving wallet saved on that invoice. Veyra does not hold that money. Use a wallet with enough supported testnet assets to fund each approved payment.</p></div>
      <div className="payroll-workflow-steps"><article><span>1</span><div><b>Invite team members</b><small>Send an invitation to each person’s Veyra email.</small></div></article><article><span>2</span><div><b>They complete payout setup</b><small>They choose a supported payout asset and wallet in their account.</small></div></article><article><span>3</span><div><b>Add them to payroll</b><small>Set compensation and pay frequency after their payout profile is ready.</small></div></article><article><span>4</span><div><b>Prepare and pay a run</b><small>Review the pay run, approve it, and send from the business wallet.</small></div></article></div>
    </section>
    {notice && <div className="inline-notice notice-success"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    {list.isLoading ? <StatePanel kind="loading" title="Loading your team" text="Checking invitations and payout profiles." /> : list.isError ? <StatePanel kind="error" title="Team did not load" text="We could not reach your team records." retry={() => list.refetch()} /> : !list.data?.length ? <EmptyState icon={<Users size={22} />} title="Invite your first team member." text="They will join Veyra and save their payout details. You can add them to payroll once their profile is ready." action={<button className="button button-green" onClick={() => setInviteModal(true)}><Plus size={16} /> Invite team member</button>} /> : <div className="table-wrap"><table><thead><tr><th>TEAM MEMBER</th><th>PAYROLL STATUS</th><th>PAYOUT DESTINATION</th><th>PAY DETAILS</th><th>ACTION</th></tr></thead><tbody>{(list.data as (EmployeeRosterRecord & { id: string; userId?: string | null; payoutProfileCompleted?: boolean; payrollEnabled?: boolean })[]).map((person) => <tr key={person.id} data-testid={`row-employee-${person.id}`}><td><div className="person-cell"><span className="person-initials">{person.name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()}</span><span><b className="cell-primary">{person.name}</b><small className="cell-secondary">{person.email}</small></span></div></td><td>{person.payrollEnabled ? <span className="status-pill status-success"><span />On payroll</span> : person.payoutProfileCompleted ? <span className="status-pill status-pending"><span />Ready to add</span> : person.userId ? <span className="status-pill status-pending"><span />Completing payout setup</span> : <span className="status-pill status-draft"><span />Invitation sent</span>}</td><td><div className="wallet-cell"><b>{person.preferredStablecoin}</b><small>{person.preferredNetwork}{person.walletAddress ? ` · ${shorten(person.walletAddress)}` : ' · Waiting for member'}</small></div></td><td>{person.payrollEnabled ? <><b>{formatDecimalAmount(person.compensationCurrency, person.compensationAmount)}</b><small className="cell-secondary">{person.payFrequency}</small></> : 'Not set'}</td><td><div className="payroll-profile-actions">{person.payoutProfileCompleted && !person.payrollEnabled ? <button className="button button-green button-small" onClick={() => { setEmployeeSaveError(''); setEmployeeToEdit(person); setModal(true); }}>Add to payroll</button> : person.payrollEnabled ? <button className="button button-outline button-small" onClick={() => { setEmployeeSaveError(''); setEmployeeToEdit(person); setModal(true); }}>Edit pay</button> : !person.userId ? <button className="button button-outline button-small" onClick={() => void resendInvitation(person)} disabled={inviteBusy === person.id}>{inviteBusy === person.id ? 'Sending…' : 'Resend invitation'}</button> : <span className="cell-secondary">Waiting for profile</span>}<button className="button button-outline button-small" onClick={() => void removeEmployee(person)}>Remove</button></div></td></tr>)}</tbody></table></div>}
    <section className="panel-card payroll-cycle-panel"><div className="panel-heading"><div><span className="page-eyebrow">ORGANIZATION PAY RUN</span><h2>Prepare and pay your team</h2><p>Choose the period, review every person and payout, then start the whole run from your wallet.</p></div></div><div className="payroll-cycle-form"><label>Pay frequency<select value={cycleFrequency} onChange={(event) => setCycleFrequency(event.target.value as typeof cycleFrequency)}><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option></select></label><label>Period starts<input type="date" value={cycleStart} onChange={(event) => setCycleStart(event.target.value)} /></label><label>Period ends<input type="date" value={cycleEnd} onChange={(event) => setCycleEnd(event.target.value)} /></label><label>Planned pay date<input type="date" value={cyclePayDate} onChange={(event) => setCyclePayDate(event.target.value)} /></label><button className="button button-green" onClick={() => void prepareCycle()} disabled={cycleBusy || payrollReadyCount === 0}>{cycleBusy ? 'Preparing…' : 'Create pay run'} <ArrowRight size={15} /></button></div>{payrollReadyCount === 0 && <p className="form-footnote">Add a team member with a completed payout profile to start a pay run.</p>}
      {payrollCycles.length > 0 && <div className="payroll-cycle-list">{payrollCycles.map((cycle) => { const paid = cycle.items.filter((item) => item.status === 'paid').length; const failed = cycle.items.filter((item) => item.status === 'failed').length; const processingPayments = cycle.items.filter((item) => item.status === 'processing' || (!!item.depositTxHash && item.status !== 'paid' && item.status !== 'failed')).length; const pending = cycle.items.length - paid - failed - processingPayments; const needsQuote = cycle.items.filter((item) => (item.status === 'queued' || item.status === 'failed') && !item.paymentQuote?.reconciliationStatus?.includes('unmatched')); const batchable = cycle.items.filter((item) => item.status === 'pending_settlement' && !item.depositTxHash && item.paymentQuote?.originAssetSymbol && item.paymentQuote?.originAssetNetwork && item.paymentQuote.reconciliationStatus !== 'unmatched_payroll'); const firstBatch = batchable[0]; const sameAssetBatch = firstBatch ? batchable.filter((item) => item.paymentQuote?.originAssetSymbol === firstBatch.paymentQuote?.originAssetSymbol && item.paymentQuote?.originAssetNetwork === firstBatch.paymentQuote?.originAssetNetwork) : []; return <article className="payroll-cycle-card" id={`cycle-${cycle.id}`} key={cycle.id}><div className="payroll-cycle-row"><div><b>{cycle.frequency} pay run · {cycle.periodStart}–{cycle.periodEnd}</b><small>Pay date {cycle.paymentDate} · {cycle.items.length} staff · {Object.entries(cycle.totals).map(([currency, amount]) => `${amount} ${currency}`).join(' · ')}</small><small className="payroll-cycle-counts">{paid} paid <span>·</span> {processingPayments} processing <span>·</span> {pending} awaiting payment <span>·</span> {failed} failed</small></div><span className={`status-pill ${['approved', 'processing', 'partially_failed'].includes(cycle.status) ? 'status-pending' : cycle.status === 'completed' ? 'status-paid' : cycle.status === 'failed' ? 'status-error' : 'status-draft'}`}><span />{cycle.status.replace(/_/g, ' ')}</span><div className="payroll-run-actions">{cycle.status === 'draft' && <><button className="button button-outline button-small" onClick={() => void refreshDraftCycle(cycle.id)} disabled={cycleBusy}>Refresh draft</button><button className="button button-outline button-small" onClick={() => void discardDraftCycle(cycle)} disabled={cycleBusy}>Discard draft</button><button className="button button-green button-small" onClick={() => void approveCycle(cycle.id)} disabled={cycleBusy}>Review & approve</button></>}{cycle.status !== 'draft' && needsQuote.length > 0 && <button className="button button-outline" onClick={() => void openBatchPayout(cycle)} disabled={payoutBusy || cycleBusy}>Prepare all payouts ({needsQuote.length})</button>}{sameAssetBatch.length > 0 && <button className="button button-green" onClick={() => void sendPayrollBatch(sameAssetBatch)} disabled={cycleBusy}>Pay all {sameAssetBatch.length} ready payments</button>}</div></div><div className="payroll-run-next-step">{cycle.status === 'draft' ? 'Draft snapshot · Refresh draft to load current team pay settings before approval.' : needsQuote.length ? `Step 2 · Prepare provider quotes for ${needsQuote.length} ${needsQuote.length === 1 ? 'person' : 'people'} using one source asset.` : sameAssetBatch.length ? `Step 3 · ${sameAssetBatch.length} payments are ready from ${firstBatch?.paymentQuote?.originAssetSymbol} on ${firstBatch?.paymentQuote?.originAssetNetwork}.` : cycle.status === 'completed' ? 'All payments in this run are confirmed.' : 'Payments are being checked with the provider.'}</div><details className="payroll-items-details"><summary>Review staff and individual payment status</summary><div className="payroll-items-list">{cycle.items.map((item) => <PayrollPaymentItem key={item.id} cycleId={cycle.id} item={item} busy={cycleBusy || payoutBusy} onPrepare={openPayout} onCheck={checkPayout} />)}</div></details></article>; })}</div>}
    </section>
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>Approval is not settlement.</b> Each employee payment is tracked independently. No payment is shown as paid until the settlement integration verifies it.</span></div>
    {batchTarget && <Modal title="Prepare the team’s payouts" subtitle="Veyra uses the organization owner’s Privy wallet for the chosen source asset. No wallet address needs to be entered." onClose={() => { if (!payoutBusy) setBatchTarget(null); }}><form className="form-stack" onSubmit={(event) => void prepareAllPayouts(event)}><div className="payroll-batch-summary"><b>{batchTarget.items.filter((item) => item.status === 'queued' || item.status === 'failed').length} staff payments to prepare</b><span>{Object.entries(batchTarget.totals).map(([currency, amount]) => `${currency} ${amount}`).join(' · ')}</span><small>The employee payout asset and destination are already saved in each team member’s profile.</small><div className="payroll-batch-owner-wallet"><span>Paying from the owner’s wallet</span><code>{payoutRefundTo ? shorten(payoutRefundTo) : payoutBusy ? 'Loading wallet…' : 'Wallet unavailable'}</code></div></div><label>Owner pays with<select required value={payoutSource} disabled={payoutBusy} onChange={(event) => void changeBatchSource(event.target.value)}>{payoutAssets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain}</option>)}</select></label>{payoutError && <p className="form-error">{payoutError}</p>}<p className="form-footnote">Preparing quotes does not move funds. Pay all sends from this owner wallet; your wallet will ask you to approve the transactions.</p><div className="form-actions"><button type="button" className="button button-outline" onClick={() => setBatchTarget(null)} disabled={payoutBusy}>Cancel</button><button className="button button-green" disabled={payoutBusy || !payoutSource || !payoutRefundTo.trim()}>{payoutBusy ? 'Loading wallet or preparing quotes…' : 'Prepare all payouts'} <ArrowRight size={15} /></button></div></form></Modal>}
    {payoutTarget && <Modal title={`Prepare payout for ${payoutTarget.item.employeeName}`} subtitle="Use the organization owner’s Privy wallet as the payer. Veyra creates the route and the owner approves the transfer in that wallet." onClose={() => { if (!payoutBusy) setPayoutTarget(null); }}><form className="form-stack" onSubmit={(event) => void preparePayout(event)}><div className="payroll-payout-summary"><span>Approved salary<b>{formatDecimalAmount(payoutTarget.item.currency, payoutTarget.item.amount)}</b></span><span>Employee receives<b>{payoutTarget.item.stablecoin} · {payoutTarget.item.network}</b></span><span>Wallet<b>{payoutTarget.item.walletAddress ? shorten(payoutTarget.item.walletAddress) : 'Address missing'}</b></span></div><label>Owner pays with<select required value={payoutSource} disabled={payoutBusy} onChange={(event) => void changeBatchSource(event.target.value)}>{payoutAssets.filter((asset) => asset.symbol.toUpperCase() !== payoutTarget.item.stablecoin.toUpperCase() || asset.blockchain.toLowerCase() !== payoutTarget.item.network.toLowerCase()).map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain}</option>)}</select></label><div className="payroll-batch-owner-wallet"><span>Paying from the owner’s wallet</span><code>{payoutRefundTo ? shorten(payoutRefundTo) : payoutBusy ? 'Loading wallet…' : 'Wallet unavailable'}</code></div>{payoutError && <p className="form-error">{payoutError}</p>}<p className="form-footnote">The quote locks the employee’s payout amount. Preparing it does not move funds; you approve the exact transfer from this owner wallet.</p><div className="form-actions"><button type="button" className="button button-outline" onClick={() => setPayoutTarget(null)} disabled={payoutBusy}>Cancel</button><button className="button button-green" disabled={payoutBusy || !payoutSource || !payoutRefundTo.trim()}>{payoutBusy ? 'Preparing signed quote…' : 'Prepare signed quote'} <ArrowRight size={15} /></button></div></form></Modal>}
    {modal && employeeToEdit && <Modal title={employeeToEdit.payrollEnabled ? 'Edit payroll details' : 'Add team member to payroll'} subtitle={employeeToEdit.payrollEnabled ? 'Change this person’s compensation for future pay runs.' : 'Set compensation now that this team member has completed payout setup.'} onClose={() => { if (!employeeSaveBusy) { setModal(false); setEmployeeToEdit(null); } }}><form className="form-stack" onSubmit={submit}><div className="payroll-payout-summary"><span>Team member<b>{employeeToEdit.name}</b></span><span>Receives<b>{employeeToEdit.preferredStablecoin} · {employeeToEdit.preferredNetwork}</b></span><span>Wallet<b>{employeeToEdit.walletAddress ? shorten(employeeToEdit.walletAddress) : 'Address not saved'}</b></span></div><div className="form-pair amount-pair"><label>Pay amount<input type="text" inputMode="decimal" name="amount" required pattern="(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,6})?" placeholder="0.00" defaultValue={employeeToEdit.payrollEnabled ? employeeToEdit.compensationAmount : ''} /></label><label>Currency<input name="currency" required minLength={3} maxLength={3} defaultValue={employeeToEdit.payrollEnabled ? employeeToEdit.compensationCurrency : 'USD'} /></label></div><label>Pay frequency<select name="frequency" defaultValue={employeeToEdit.payrollEnabled ? employeeToEdit.payFrequency : 'monthly'}><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option></select></label>{employeeSaveError && <p className="form-error" role="alert">{employeeSaveError}</p>}<div className="form-actions"><button type="button" className="button button-outline" disabled={employeeSaveBusy} onClick={() => { setModal(false); setEmployeeToEdit(null); }}>Cancel</button><button className="button button-green" disabled={employeeSaveBusy}>{employeeSaveBusy ? (employeeToEdit.payrollEnabled ? 'Saving pay details…' : 'Adding to payroll…') : (employeeToEdit.payrollEnabled ? 'Save pay details' : 'Add to payroll')} {!employeeSaveBusy && <ArrowRight size={15} />}</button></div><p className="form-footnote">This only saves payroll details. No payment is made until you prepare and approve a pay run.</p></form></Modal>}
    {inviteModal && <Modal title="Invite a team member" subtitle="Invite someone who already uses Veyra or a new teammate. Both join through their email invitation." onClose={() => setInviteModal(false)}><form className="form-stack" onSubmit={(event) => void inviteEmployee(event)}><label>Team member name<input name="name" required maxLength={160} placeholder="Full name" /></label><label>Email they use for Veyra, or will register with<input type="email" name="email" required placeholder="name@company.com" /></label>{notice && <p className="form-error">{notice}</p>}<div className="form-actions"><button type="button" className="button button-outline" onClick={() => setInviteModal(false)}>Cancel</button><button className="button button-green" disabled={inviteBusy === 'new'}>{inviteBusy === 'new' ? 'Sending invitation…' : 'Send invitation'} <ArrowRight size={15} /></button></div><p className="form-footnote">Existing users sign in with this email. New users create their Veyra account from the invitation. Then they choose where to receive pay; you set compensation and add them to payroll.</p></form></Modal>}
  </AppFrame>;
}

type EmployeePortalProfile = { id: string; name: string; email: string; country: string; position: string; compensationAmount: string; compensationCurrency: string; payFrequency: string; preferredStablecoin: string; preferredNetwork: string; walletAddress: string | null; workspaceName: string };
type EmployeePayment = { id: string; amount: string; currency: string; payoutAmount: string | null; stablecoin: string; network: string; status: string; failureReason: string | null; providerReference: string | null; periodStart: string; periodEnd: string; paymentDate: string };

function EmployeeInvitationPage({ token }: { token: string }) {
  const { user, signIn } = useAuth(); const privy = usePrivyWallet();
  const [invite, setInvite] = useState<{ email: string; employeeName: string; position: string; workspaceId: string; workspaceName: string; alreadyLinked?: boolean; payoutProfileCompleted?: boolean } | null>(null);
  const [assets, setAssets] = useState<PayrollAsset[]>([]); const [assetId, setAssetId] = useState(''); const [walletAddress, setWalletAddress] = useState('');
  const [nearWalletAddress, setNearWalletAddress] = useState(''); const [personalReceiveDefaults, setPersonalReceiveDefaults] = useState<{ near?: string; evm?: string }>({});
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [addressEdited, setAddressEdited] = useState(false);
  useEffect(() => { let active = true; apiFetch('/api/auth/employee-invitation/' + encodeURIComponent(token)).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error || 'This invitation could not be loaded.'); if (active) setInvite(body); }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'This invitation could not be loaded.'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [token]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    void Promise.all([apiFetch('/api/employee/supported-assets'), apiFetch('/api/auth/wallets'), apiFetch('/api/personal-profile/preferences')]).then(async ([assetResponse, walletResponse, preferenceResponse]) => {
      const [assetBody, walletBody, preferenceBody] = await Promise.all([assetResponse.json(), walletResponse.json(), preferenceResponse.json()]);
      if (!assetResponse.ok) throw new Error(assetBody.error || 'Payout assets could not be loaded.');
      if (!walletResponse.ok) throw new Error(walletBody.error || 'Your Privy wallets could not be loaded.');
      if (!preferenceResponse.ok) throw new Error(preferenceBody.error || 'Your personal wallet settings could not be loaded.');
      const available = assetBody.assets as PayrollAsset[];
      const wallets = walletBody.wallets as { network: string; address: string; provider: string }[];
      const near = wallets.find((wallet) => wallet.network === 'near:testnet' && wallet.provider === 'privy')?.address || '';
      const defaults = preferenceBody.defaultReceiveAddresses || {};
      if (!active) return;
      setAssets(available); setNearWalletAddress(near); setPersonalReceiveDefaults(defaults);
      const evmChain = (chain: string) => ['eth', 'ethereum', 'base', 'op', 'optimism', 'arb', 'arbitrum', 'pol', 'polygon', 'bsc', 'avax', 'avalanche'].includes(chain.toLowerCase());
      const preferred = (defaults.near && available.find((asset) => asset.blockchain.toLowerCase() === 'near' && asset.symbol.toUpperCase() === 'USDC'))
        || (defaults.evm && available.find((asset) => evmChain(asset.blockchain) && asset.symbol.toUpperCase() === 'USDC'))
        || (privy.privyAddress && available.find((asset) => evmChain(asset.blockchain) && asset.symbol.toUpperCase() === 'USDC'))
        || (near && available.find((asset) => asset.blockchain.toLowerCase() === 'near' && asset.symbol.toUpperCase() === 'USDC'))
        || (privy.privyAddress && available.find((asset) => evmChain(asset.blockchain)))
        || (near && available.find((asset) => asset.blockchain.toLowerCase() === 'near'));
      if (preferred) setAssetId((current) => current || preferred.assetId);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Payout details could not be loaded.'); });
    return () => { active = false; };
  }, [user, privy.privyAddress]);
  useEffect(() => {
    if (!user || !assets.length || addressEdited) return;
    const selected = assets.find((asset) => asset.assetId === assetId);
    if (!selected) return;
    const network = selected.blockchain.toLowerCase();
    const address = network === 'near' ? personalReceiveDefaults.near || nearWalletAddress
      : ['eth', 'ethereum', 'base', 'op', 'optimism', 'arb', 'arbitrum', 'pol', 'polygon', 'bsc', 'avax', 'avalanche'].includes(network) ? personalReceiveDefaults.evm || privy.privyAddress : '';
    setWalletAddress(address || '');
  }, [assetId, assets, user, privy.privyAddress, addressEdited, nearWalletAddress, personalReceiveDefaults]);
  const [, navigate] = useLocation();
  const completeProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await apiFetch('/api/auth/employee-invitation/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invitationToken: token, completeProfile: true, assetId, walletAddress }),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Your team profile could not be completed.');
      if (body.workspaceId) localStorage.setItem(ACTIVE_WORKSPACE_KEY, body.workspaceId);
      navigate('/app/organization');
    } catch (cause) {
      const timedOut = cause instanceof DOMException && cause.name === 'TimeoutError';
      setError(timedOut
        ? 'Saving is taking longer than expected. Reload this invitation to check whether it completed, then retry if it did not.'
        : cause instanceof Error ? cause.message : 'Your team profile could not be completed.');
      setBusy(false);
    }
  };
  const signInToJoin = async () => { setBusy(true); setError(''); try { await signIn('', ''); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Privy sign-in could not be opened.'); setBusy(false); } };
  const selected = assets.find((asset) => asset.assetId === assetId);
  return <main className="auth-page employee-invitation-page">
    <section className="auth-side employee-invitation-story">
      <Brand light />
      <div><div className="eyebrow"><span className="eyebrow-line" /> TEAM INVITATION</div><h1>{loading ? 'Opening your invitation.' : invite ? <>Join <em>{invite.workspaceName}.</em></> : 'Your team is expecting you.'}</h1><p>{invite ? `${invite.employeeName}${invite.position ? ` · ${invite.position}` : ''} has invited you to join the organization.` : 'Use the invitation link from your email to continue.'}</p></div>
      <span className="auth-note">Your organization membership is added alongside your personal freelancer workspace.</span>
    </section>
    <section className="auth-form-side employee-invitation-form-side">
      <Link href="/" className="auth-back"><ArrowDownRight size={15} /> Back to Veyra</Link>
      <div className="employee-invitation-card">
        {loading ? <StatePanel kind="loading" title="Checking your invitation" text="Confirming the organization and invitation email." /> : invite ? <>
          <span className="page-eyebrow">COMPLETE YOUR TEAM PROFILE</span>
          <h2>{invite.workspaceName}</h2>
          <p className="employee-invitation-recipient">Invitation for <b>{invite.email}</b></p>
          {invite.alreadyLinked && invite.payoutProfileCompleted ? <><p>You have joined this organization. Your account also has a personal freelancer workspace for sending invoices.</p>{user ? <button type="button" className="button button-green" onClick={() => { localStorage.setItem(ACTIVE_WORKSPACE_KEY, invite.workspaceId); navigate('/app/organization'); }}>Open {invite.workspaceName} <ArrowRight size={15} /></button> : <button className="button button-green" onClick={() => void signInToJoin()} disabled={busy || !privy.privyReady}>{busy ? 'Opening Privy…' : 'Sign in to Veyra'} <ArrowRight size={15} /></button>}</> : !user ? <><p>Already use Veyra? Sign in with this email. New to Veyra? Create your account with this email. Accepting this invitation adds the organization and a personal freelancer workspace, so you can also send invoices. You do not need to choose an account type here.</p>{error && <p className="form-error">{error}</p>}<button className="button button-green" onClick={() => void signInToJoin()} disabled={busy || !privy.privyReady}>{busy ? 'Opening Privy…' : 'Continue with Privy'} <ArrowRight size={15} /></button></> : <form className="form-stack" onSubmit={(event) => void completeProfile(event)}>
            <label>Receive payroll as<select required value={assetId} onChange={(event) => { setAssetId(event.target.value); setAddressEdited(false); }}><option value="" disabled>Select a supported asset and network</option>{assets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain} testnet</option>)}</select></label>
            <label>Payout wallet address<input className="employee-wallet-address" required value={walletAddress} onChange={(event) => { setWalletAddress(event.target.value); setAddressEdited(true); }} autoComplete="off" placeholder={selected?.blockchain.toLowerCase() === 'near' ? 'Your Privy NEAR testnet account' : 'Your Privy EVM wallet'} /></label>
            <p className="form-footnote">Your personal freelancer workspace is added automatically when you join. Organization and freelancer work stay separate. Your Privy wallet is filled in for payroll; change it only if you want pay sent somewhere else.</p>
            {error && <p className="form-error">{error}</p>}
            <button className="button button-green" disabled={busy || !assetId || !walletAddress.trim()}>{busy ? 'Saving payout profile…' : 'Join team and save payout profile'} <ArrowRight size={15} /></button>
          </form>}</> : <><span className="page-eyebrow">INVITATION UNAVAILABLE</span><h2>We couldn’t open this invitation.</h2><p>{error || 'Ask the organization owner to send you a new invitation.'}</p><Link href="/" className="button button-outline">Return to Veyra</Link></>}
      </div>
    </section>
  </main>;
}

function EmployeePortalPage() {
  const [profile, setProfile] = useState<EmployeePortalProfile | null>(null);
  const [payments, setPayments] = useState<EmployeePayment[]>([]);
  const [assets, setAssets] = useState<PayrollAsset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const load = async () => {
    setBusy(true); setMessage('');
    try {
      const [profileResponse, paymentsResponse, assetsResponse] = await Promise.all([apiFetch('/api/employee/me'), apiFetch('/api/employee/payments'), apiFetch('/api/employee/supported-assets')]);
      const [profileBody, paymentBody, assetBody] = await Promise.all([profileResponse.json(), paymentsResponse.json(), assetsResponse.json()]);
      if (!profileResponse.ok) throw new Error(profileBody.error || 'Your employee account could not be loaded.');
      if (!paymentsResponse.ok) throw new Error(paymentBody.error || 'Your pay history could not be loaded.');
      if (!assetsResponse.ok) throw new Error(assetBody.error || 'Supported payout options could not be loaded.');
      setProfile(profileBody); setPayments(paymentBody); setAssets(assetBody.assets);
      setWalletAddress(profileBody.walletAddress || '');
      const selected = assetBody.assets.find((asset: PayrollAsset) => asset.symbol.toUpperCase() === profileBody.preferredStablecoin.toUpperCase() && asset.blockchain.toLowerCase() === profileBody.preferredNetwork.toLowerCase());
      setAssetId(selected?.assetId || '');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Your employee account could not be loaded.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const savePreferences = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      const response = await apiFetch('/api/employee/me/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId, walletAddress }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Your payment preferences could not be saved.');
      await load(); setMessage('Your payout preferences were saved for future payroll cycles. Approved pay runs are unchanged.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Your payment preferences could not be saved.'); }
    finally { setSaving(false); }
  };
  return <AppFrame title="Organization" eyebrow="YOUR ORGANIZATION · TEAM MEMBER"><div className="page-intro"><p>View your place on the team, manage where you receive pay, and review payments from your organization.</p><span className="intro-stamp"><Users size={16} /> TEAM MEMBERSHIP</span></div>
    {message && <div className="inline-notice"><span>{message}</span><button onClick={() => setMessage('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    {busy && !profile ? <StatePanel kind="loading" title="Loading your pay profile" text="Getting your payment preferences and history." /> : !profile ? <StatePanel kind="error" title="Employee profile unavailable" text={message || 'This account is not linked to an active employee record.'} retry={() => void load()} /> : <>
      <section className="panel-card employee-profile-card"><div><span className="page-eyebrow">{profile.workspaceName}</span><h2>{profile.name}</h2><p>{profile.position} · {profile.country} · {profile.payFrequency}</p><strong>{formatDecimalAmount(profile.compensationCurrency, profile.compensationAmount)} per pay period</strong></div><form className="form-stack" onSubmit={(event) => void savePreferences(event)}><span className="page-eyebrow">FUTURE PAYOUT PREFERENCE</span><label>Receive pay as<select required value={assetId} onChange={(event) => setAssetId(event.target.value)}><option value="" disabled>Select a supported asset and network</option>{assets.map((asset) => <option key={asset.assetId} value={asset.assetId}>{asset.symbol} · {asset.blockchain}</option>)}</select></label><label>Wallet address<input required maxLength={200} value={walletAddress} onChange={(event) => setWalletAddress(event.target.value)} autoComplete="off" /></label><button className="button button-green" disabled={saving || !assetId}>{saving ? 'Saving…' : 'Save payout preference'} <ArrowRight size={15} /></button><p className="form-footnote">Changes apply to new payroll cycles. Already approved cycles keep their saved destination.</p></form></section>
      <section className="panel-card employee-history"><div className="panel-heading"><div><span className="page-eyebrow">PAY HISTORY</span><h2>Your payroll payments</h2></div></div>{payments.length ? <div className="records-list">{payments.map((payment) => <article className="record-row" key={payment.id}><span className="record-type-icon type-payroll_payment"><Wallet size={17} /></span><span className="record-main"><b>{formatDecimalAmount(payment.currency, payment.amount)} · {payment.periodStart} to {payment.periodEnd}</b><small>Scheduled {payment.paymentDate}{payment.payoutAmount ? ` · ${payment.payoutAmount} ${payment.stablecoin} on ${payment.network}` : ''}</small>{payment.failureReason && <small className="payroll-item-error">{payment.failureReason}</small>}</span><span className={`status-pill ${payment.status === 'paid' ? 'status-paid' : payment.status === 'failed' ? 'status-error' : 'status-pending'}`}><span />{payment.status.replace(/_/g, ' ')}</span>{payment.status === 'paid' && <button type="button" className="button button-outline button-small" onClick={() => void downloadPrivateFile(`/api/employee/payments/${payment.id}/payslip`, `payslip-${payment.periodEnd}.pdf`)}>Payslip PDF</button>}</article>)}</div> : <EmptyState icon={<Wallet size={20} />} title="No payroll payments yet." text="Confirmed pay runs will appear here with their settlement status and payslip." />}</section>
    </>}
  </AppFrame>;
}

function PayrollPaymentItem({ item, cycleId, busy, onPrepare, onCheck }: {
  item: PayrollCycleSummary['items'][number]; cycleId: string; busy: boolean;
  onPrepare: (cycleId: string, item: PayrollCycleSummary['items'][number]) => void;
  onCheck: (item: PayrollCycleSummary['items'][number]) => void;
}) {
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const details = payrollQuoteDetails(item.paymentQuote?.quote);
  const depositAddress = typeof details.depositAddress === 'string' ? details.depositAddress : '';
  const depositMemo = typeof details.depositMemo === 'string' ? details.depositMemo : '';
  const sourceAsset = item.paymentQuote?.originAssetSymbol ? `${item.paymentQuote.originAssetSymbol} on ${item.paymentQuote.originAssetNetwork}` : 'source asset';
  const isMismatch = item.paymentQuote?.reconciliationStatus === 'unmatched_payroll';
  const canPrepare = !isMismatch && item.status !== 'paid' && (item.status === 'queued' || item.status === 'failed');
  const canCheck = item.status === 'processing' || item.status === 'pending_settlement';
  const originNetwork = item.paymentQuote?.originAssetNetwork?.toLowerCase() || '';
  const canWalletSend = Boolean(item.paymentQuote?.paymentId && item.paymentQuote.quote && !item.depositTxHash && item.status !== 'paid' && !isMismatch && (
    (originNetwork === 'near' && /^[a-z0-9._-]{2,64}$/.test(depositAddress)) ||
    (getEvmChainId(originNetwork) && /^0x[0-9a-f]{40}$/i.test(depositAddress))
  ) && /^\d+$/.test(String(details.amountIn || '')));
  const sendWithWallet = async () => {
    if (!item.paymentQuote?.paymentId) return;
    setSending(true); setSendError('');
    try {
      const catalogResponse = await apiFetch('/api/integrations/near-intents/assets');
      const catalog = await catalogResponse.json();
      if (!catalogResponse.ok) throw new Error(catalog.error || 'Supported assets could not be loaded.');
      const asset = (catalog.assets as PayrollAsset[]).find((candidate) => candidate.symbol === item.paymentQuote?.originAssetSymbol && candidate.blockchain === item.paymentQuote?.originAssetNetwork);
      if (!asset) throw new Error('The source asset is no longer available. Prepare a fresh payout quote.');
      const isNear = asset.blockchain.toLowerCase() === 'near';
      const hash = isNear
        ? await sendNearDeposit(asset, depositAddress, String(details.amountIn), typeof details.depositMemo === 'string' ? details.depositMemo : undefined)
        : await sendQuotedDeposit(asset, depositAddress, String(details.amountIn));
      if (hash) {
        const submitted = await apiFetch(`/api/payroll/items/${item.id}/${isNear ? 'near-deposit-submitted' : 'deposit-submitted'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: hash }) });
        if (!submitted.ok) setSendError(`Wallet transaction sent (${hash}). Provider notification is optional; check settlement status shortly.`);
      } else if (isNear) setSendError('The NEAR wallet approved the transfer. Check settlement status shortly.');
      onCheck(item);
    } catch (error) { setSendError(error instanceof Error ? error.message : 'The wallet transaction could not be sent.'); }
    finally { setSending(false); }
  };
  return <div className="payroll-item-row payroll-item-detail" key={item.id}>
    <span><b>{item.employeeName}</b><small>{item.employeeEmail}</small>{item.failureReason && <small className="payroll-item-error">{item.failureReason}</small>}{item.providerReference && <small>Provider transaction: {item.providerReference}</small>}</span>
    <span><b>{formatDecimalAmount(item.currency, item.amount)}</b><small>{item.payoutAmount ? `Payout: ${formatDecimalAmount(item.stablecoin, item.payoutAmount)} · ${item.network}` : `${item.stablecoin} · ${item.network}`}</small>{item.payoutUsdPrice && <small>Provider price: {formatDecimalAmount('USD', item.payoutUsdPrice)} per token</small>}</span>
    <span className={`status-pill ${item.status === 'paid' ? 'status-paid' : item.status === 'failed' ? 'status-error' : 'status-pending'}`}><span />{item.depositTxHash && item.status !== 'paid' ? 'submitted · processing' : item.status.replace(/_/g, ' ')}</span>
    {canPrepare && <button type="button" className="button button-outline button-small" onClick={() => onPrepare(cycleId, item)} disabled={busy}>{item.status === 'failed' ? 'Retry quote' : 'Prepare payout'}</button>}
    {canCheck && <button type="button" className="button button-outline button-small" onClick={() => onCheck(item)} disabled={busy}>{busy ? 'Checking…' : 'Check status'}</button>}
    {item.status === 'paid' && <button type="button" className="button button-outline button-small" onClick={() => void downloadPrivateFile(`/api/payroll/items/${item.id}/payslip`, `payslip-${item.employeeName.replace(/[^A-Za-z0-9_-]/g, '-')}.pdf`)}>Payslip PDF</button>}
    {isMismatch && <span className="payroll-item-error">Provider confirmed a mismatch. Do not retry this payout.</span>}
    {depositAddress && item.status !== 'paid' && <div className="payroll-deposit-instructions"><b>Payment route</b><span>Send {details.amountInFormatted ? `${formatDecimalAmount('', String(details.amountInFormatted)).trim()} ${sourceAsset}` : `the exact quoted ${sourceAsset} amount shown in your wallet`} to the provider. It will deliver {item.payoutAmount ? formatDecimalAmount(item.stablecoin, item.payoutAmount) : formatDecimalAmount(item.stablecoin, String(details.amountOutFormatted || item.amount))} to {item.employeeName} after settlement.</span><code title={depositAddress}>{depositAddress}</code>{depositMemo && <small>Memo: <code>{depositMemo}</code></small>}{item.depositTxHash && item.status !== 'paid' && <small className="payroll-deposit-submitted">Transfer submitted. Veyra will not ask you to send it again while settlement is processing.</small>}{canWalletSend && <button type="button" className="button button-green button-small" onClick={() => void sendWithWallet()} disabled={busy || sending}><Wallet size={13} /> {sending ? 'Waiting for wallet approval…' : 'Send from business wallet'}</button>}<button type="button" className="button button-outline button-small" onClick={() => void navigator.clipboard.writeText(depositAddress)}><Copy size={13} /> Copy address</button>{sendError && <small className="payroll-item-error">{sendError}</small>}<small>Review and approve the exact amount in your wallet before signing. Veyra does not custody the deposit.</small></div>}
  </div>;
}

function shorten(text: string) { return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-5)}` : text; }

type TreasuryAllocationRule = { id: string; label: string; percent: number; target: 'wallet' | 'defi' | 'aave'; address?: string; protocolId?: string };
type TreasuryIncome = { paymentId: string; invoiceNumber: string; amount: string; currency: string; assetId: string; decimals: number; network: string; recipientAddress: string; settledAt: string | null; runStatus: string | null };
type TreasuryProtocol = { id: string; name: string; action: string; network: string; assetSymbol: string; assetAddress: string; apyPercent: number | null; apyUpdatedAt: string; enabled: boolean };
type TreasuryIncomeRun = { id: string; paymentId: string; sourceAmount: string; currency: string; network: string; outputs: { label: string; target: 'wallet' | 'defi' | 'aave'; address?: string; amount: string; transactionHash?: string }[]; status: string; createdAt: string };
type TreasuryAsset = { assetId: string; decimals: number; blockchain: string; symbol: string; contractAddress?: string | null };

function treasuryAmountUnits(value: string, decimals: number) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('The received amount is not a valid decimal value.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('The received amount has more decimal places than the token supports.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

function treasuryUnitsAmount(value: bigint, decimals: number) {
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${value / scale}${fraction ? `.${fraction}` : ''}`;
}

function TreasuryPage() {
  const privy = usePrivyWallet();
  const [allocationRules, setAllocationRules] = useState<TreasuryAllocationRule[]>([]);
  const [savedAllocationRules, setSavedAllocationRules] = useState<TreasuryAllocationRule[]>([]);
  const [income, setIncome] = useState<TreasuryIncome[]>([]);
  const [incomeRuns, setIncomeRuns] = useState<TreasuryIncomeRun[]>([]);
  const [treasuryAssets, setTreasuryAssets] = useState<TreasuryAsset[]>([]);
  const [defiProtocols, setDefiProtocols] = useState<TreasuryProtocol[]>([]);
  const [savingPlan, setSavingPlan] = useState(false);
  const [runningPaymentId, setRunningPaymentId] = useState('');
  const [pendingIncome, setPendingIncome] = useState<TreasuryIncome | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadTreasury = async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      const [planResponse, incomeResponse, runsResponse, assetsResponse, protocolsResponse] = await Promise.all([
        apiFetch('/api/treasury/allocation-plan'),
        apiFetch('/api/treasury/confirmed-income'),
        apiFetch('/api/treasury/income-runs'),
        apiFetch('/api/integrations/near-intents/assets'),
        apiFetch('/api/treasury/defi/protocols'),
      ]);
      const [planBody, incomeBody, runsBody, assetsBody, protocolsBody] = await Promise.all([planResponse.json(), incomeResponse.json(), runsResponse.json(), assetsResponse.json(), protocolsResponse.json()]);
      if (!planResponse.ok) throw new Error(planBody.error || 'Treasury allocation plan could not be loaded.');
      if (!incomeResponse.ok) throw new Error(incomeBody.error || 'Confirmed receipts could not be loaded.');
      if (!runsResponse.ok) throw new Error(runsBody.error || 'Treasury activity could not be loaded.');
      if (!assetsResponse.ok) throw new Error(assetsBody.error || 'Supported testnet assets could not be loaded.');
      if (!protocolsResponse.ok) throw new Error(protocolsBody.error || 'Available DeFi destinations could not be loaded.');
      const savedRules = Array.isArray(planBody.rules) ? (planBody.rules as TreasuryAllocationRule[]).map((rule) => rule.target === 'aave' ? { ...rule, target: 'defi' as const, protocolId: rule.protocolId || 'aave-v3-base-sepolia-usdc' } : rule) : [];
      setAllocationRules(savedRules);
      setSavedAllocationRules(savedRules);
      setIncome(Array.isArray(incomeBody) ? incomeBody : []);
      setIncomeRuns(Array.isArray(runsBody) ? runsBody : []);
      setTreasuryAssets(Array.isArray(assetsBody.assets) ? assetsBody.assets : []);
      setDefiProtocols(Array.isArray(protocolsBody.protocols) ? protocolsBody.protocols : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Treasury could not be refreshed.'); }
    finally { setLoading(false); setRefreshing(false); }
  };
  useEffect(() => { if (privy.privyReady) void loadTreasury(); }, [privy.privyReady]);
  const saveAllocationPlan = async () => {
    setSavingPlan(true); setError(''); setMessage('');
    try {
      const response = await apiFetch('/api/treasury/allocation-plan', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: allocationRules }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'The allocation plan could not be saved.');
      setAllocationRules(body.rules || []); setSavedAllocationRules(body.rules || []); setMessage('Allocation plan saved. It will only run when you choose a confirmed receipt and approve the wallet actions.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The allocation plan could not be saved.'); }
    finally { setSavingPlan(false); }
  };

  const executeIncomePlan = async (payment: TreasuryIncome) => {
    if (JSON.stringify(allocationRules) !== JSON.stringify(savedAllocationRules)) { setError('Save your edited allocation plan before running a receipt.'); return; }
    const source = treasuryAssets.find((asset) => asset.assetId === payment.assetId);
    if (!source) { setError(`The received ${payment.currency} asset is no longer supported in the asset catalog.`); return; }
    const totalUnits = treasuryAmountUnits(payment.amount, payment.decimals);
    const planned = allocationRules.map((rule) => ({ rule, units: totalUnits * BigInt(rule.percent) / 100n })).filter((entry) => entry.units > 0n);
    if (!planned.length) { setError('Your saved plan has no nonzero allocations for this receipt.'); return; }
    if (planned.some(({ rule }) => rule.target === 'defi' && !defiProtocols.some((protocol) => protocol.enabled && protocol.id === rule.protocolId))) {
      setError('A selected DeFi destination is no longer available. Choose an available protocol in your Treasury settings and save the plan again.'); return;
    }
    if (planned.some(({ rule }) => rule.target === 'defi' && (rule.protocolId !== AAVE_BASE_SEPOLIA.strategyId || source.blockchain.toLowerCase() !== 'base' || source.symbol.toUpperCase() !== 'USDC' || source.contractAddress?.toLowerCase() !== AAVE_BASE_SEPOLIA.usdc.toLowerCase()))) {
      setError('Aave V3 accepts only its supported Base Sepolia USDC asset. This receipt uses a different asset or network, so change its allocation destination.'); return;
    }
    if (planned.some(({ rule }) => rule.target === 'wallet' && source.blockchain.toLowerCase() !== payment.network.toLowerCase())) { setError('Wallet destinations in this plan must use the same network as the receipt. Cross-network allocations need a separate NEAR Intents route.'); return; }
    let signerAddress = '';
    if (source.blockchain.toLowerCase() === 'near') signerAddress = await connectNearWallet();
    else {
      if (!privy.privyAuthenticated || !privy.privyAddress) { setError('Your Privy wallet is not ready to approve this allocation.'); return; }
      signerAddress = privy.privyAddress;
    }
    if (source.blockchain.toLowerCase() === 'near' ? signerAddress !== payment.recipientAddress : signerAddress.toLowerCase() !== payment.recipientAddress.toLowerCase()) {
      setError('This receipt was delivered to a different wallet. Treasury will only move funds from the wallet that received them.'); return;
    }
    const invalid = planned.find(({ rule }) => rule.target === 'wallet' && !(source.blockchain.toLowerCase() === 'near' ? /^[a-z0-9._-]{2,64}$/.test(rule.address || '') : /^0x[0-9a-f]{40}$/i.test(rule.address || '')));
    if (invalid) { setError(`The saved wallet address for ${invalid.rule.label} does not match ${payment.network}.`); return; }
    setRunningPaymentId(payment.paymentId); setError(''); setMessage('');
    let runId = '';
    const completedOutputs: TreasuryIncomeRun['outputs'] = [];
    try {
      const startResponse = await apiFetch('/api/treasury/income-runs/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentId: payment.paymentId }) });
      const startBody = await startResponse.json(); if (!startResponse.ok) throw new Error(startBody.error || 'This receipt already has a Treasury run. Refresh its status before trying again.');
      runId = startBody.id;
      if (source.blockchain.toLowerCase() === 'near') {
        const walletRules = planned.filter(({ rule }) => rule.target === 'wallet');
        if (walletRules.length) {
          const hashes = await sendNearDepositsBatch(source, walletRules.map(({ rule, units }) => ({ depositAddress: rule.address!, amountIn: units.toString() })));
          walletRules.forEach(({ rule, units }, index) => completedOutputs.push({ label: rule.label, target: 'wallet', address: rule.address, amount: treasuryUnitsAmount(units, payment.decimals), ...(hashes[index] ? { transactionHash: hashes[index] } : {}) }));
          if (hashes.some((hash) => !hash)) throw new Error('The NEAR wallet did not return every transaction reference. Check its activity before retrying this receipt.');
        }
      } else {
        for (const { rule, units } of planned) {
          const amount = units.toString();
          let transactionHash: string;
          if (rule.target === 'defi') {
            const approvalHash = await privy.sendPrivyContractCall(AAVE_BASE_SEPOLIA.usdc, approveUsdcCall(units));
            await privy.waitForPrivyTransaction(approvalHash);
            transactionHash = await privy.sendPrivyContractCall(AAVE_BASE_SEPOLIA.pool, aaveSupplyCall(units, signerAddress));
            await privy.waitForPrivyTransaction(transactionHash);
          } else {
            transactionHash = await privy.sendPrivyDeposit(source, rule.address!, amount);
            await privy.waitForPrivyTransaction(transactionHash);
          }
          completedOutputs.push({ label: rule.label, target: rule.target === 'defi' ? 'defi' : 'wallet', ...(rule.address ? { address: rule.address } : {}), amount: treasuryUnitsAmount(units, payment.decimals), transactionHash });
        }
      }
      const finishResponse = await apiFetch(`/api/treasury/income-runs/${runId}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', outputs: completedOutputs }) });
      const finishBody = await finishResponse.json(); if (!finishResponse.ok) throw new Error(finishBody.error || 'Wallet actions completed, but Treasury could not save the run history. Check the wallet activity before retrying.');
      setPendingIncome(null); setMessage(`Treasury plan completed for ${payment.invoiceNumber}. The unallocated ${100 - allocationRules.reduce((sum, rule) => sum + rule.percent, 0)}% remains in the receiving wallet.`); await loadTreasury(true);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : 'The Treasury allocation could not be completed.';
      if (runId) {
        const status = completedOutputs.length ? 'partial' : 'cancelled';
        await apiFetch(`/api/treasury/income-runs/${runId}/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, outputs: completedOutputs }) }).catch(() => undefined);
      }
      setError(completedOutputs.length ? `${detail} ${completedOutputs.length} transfer(s) already completed. Check wallet activity before any retry.` : detail);
    } finally { setRunningPaymentId(''); }
  };

  const allocatedPercent = allocationRules.reduce((sum, rule) => sum + (Number.isFinite(rule.percent) ? rule.percent : 0), 0);
  return <AppFrame title="Treasury" eyebrow="PLAN AND DIRECT YOUR MONEY" action={<Link href="/app/wallets" className="button button-outline"><Wallet size={15} /> Your wallet</Link>}>
    <div className="defi-treasury-intro"><div><span className="page-eyebrow">YOUR MONEY STAYS IN YOUR WALLET</span><h2>Decide what happens when money arrives.</h2><p>Save percentages for the wallets and strategies you use. When an invoice payment is confirmed, review that receipt, run your plan, and approve the transfers yourself. Anything unassigned stays in the wallet that received the money.</p></div><span className="defi-network-pill"><Globe2 size={15} /> TESTNET</span></div>
    {error && <div className="inline-notice notice-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss"><X size={15} /></button></div>}
    {message && <div className="inline-notice notice-success" role="status"><span>{message}</span><button type="button" onClick={() => setMessage('')} aria-label="Dismiss"><X size={15} /></button></div>}
    <div className="treasury-summary-strip"><article><small>INCOME READY</small><strong>{income.length}</strong><span>Confirmed receipts to review</span></article><article><small>ALLOCATED</small><strong>{allocatedPercent}%</strong><span>{Math.max(0, 100 - allocatedPercent)}% stays in the receiving wallet</span></article><article><small>DESTINATIONS</small><strong>{allocationRules.length}</strong><span>Saved wallet or DeFi destinations</span></article></div>
    <>
      <section className="treasury-allocation-plan"><div className="panel-heading"><div><span className="page-eyebrow">YOUR SAVED FUND PLAN</span><h2>Choose where received money goes</h2><p>Set the percentage for each destination. You can send shares to another wallet or choose a DeFi protocol here. Unassigned money stays in the receiving wallet; saving a plan never moves funds.</p><p>Available protocols and their live testnet APY are shown when you add a DeFi destination. A protocol can only be selected for assets and networks it supports.</p></div><span className="panel-ornament"><SlidersHorizontal size={17} /></span></div>
        <div className="treasury-allocation-rules">{allocationRules.length === 0 && <p className="treasury-empty-copy">No destinations yet. Add a wallet address or choose DeFi to see supported protocols.</p>}{allocationRules.map((rule, index) => { const protocol = defiProtocols.find((item) => item.id === rule.protocolId); return <div className="treasury-allocation-rule" key={rule.id}><label>Destination name<input value={rule.label} maxLength={60} onChange={(event) => setAllocationRules((current) => current.map((item, i) => i === index ? { ...item, label: event.target.value } : item))} placeholder="Savings wallet" /></label><label>Share (%)<input type="number" min="1" max="100" step="1" value={rule.percent} onChange={(event) => setAllocationRules((current) => current.map((item, i) => i === index ? { ...item, percent: Number(event.target.value) } : item))} /></label><label>Destination type<select value={rule.target === 'aave' ? 'defi' : rule.target} onChange={(event) => setAllocationRules((current) => current.map((item, i) => i === index ? { ...item, target: event.target.value as 'wallet' | 'defi', address: event.target.value === 'wallet' ? item.address || '' : undefined, protocolId: event.target.value === 'defi' ? item.protocolId || defiProtocols.find((choice) => choice.enabled)?.id : undefined } : item))}><option value="wallet">Another wallet</option><option value="defi">DeFi protocol</option></select></label>{rule.target === 'wallet' && <label>Wallet address<input value={rule.address || ''} onChange={(event) => setAllocationRules((current) => current.map((item, i) => i === index ? { ...item, address: event.target.value } : item))} placeholder="Address on the receiving network" autoComplete="off" /></label>}{rule.target === 'defi' && <label>Available protocol<select value={rule.protocolId || ''} onChange={(event) => setAllocationRules((current) => current.map((item, i) => i === index ? { ...item, protocolId: event.target.value } : item))}><option value="">Choose a protocol</option>{defiProtocols.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.assetSymbol} · {item.network} · {item.apyPercent === null ? 'APY unavailable' : `${item.apyPercent.toFixed(2)}% APY`}</option>)}</select><small className="treasury-protocol-yield">{protocol ? protocol.apyPercent === null ? 'Live APY unavailable' : `${protocol.apyPercent.toFixed(2)}% live APY · updated ${new Date(protocol.apyUpdatedAt).toLocaleTimeString()}` : 'No available protocol selected'} · testnet rate can change and has no real monetary value.</small></label>}<button className="button button-outline button-small" type="button" aria-label={`Remove ${rule.label || 'destination'}`} onClick={() => setAllocationRules((current) => current.filter((_, i) => i !== index))}><Trash2 size={14} /> Remove</button></div>; })}</div>
        <div className="treasury-plan-footer"><span>{allocatedPercent}% allocated · {Math.max(0, 100 - allocatedPercent)}% stays in receiving wallet</span><div><button className="button button-outline" type="button" onClick={() => setAllocationRules((current) => current.length >= 10 ? current : [...current, { id: crypto.randomUUID(), label: '', percent: 10, target: 'wallet', address: '' }])} disabled={allocationRules.length >= 10}><Plus size={14} /> Add destination</button><button className="button button-green" type="button" onClick={() => void saveAllocationPlan()} disabled={savingPlan || allocationRules.some((rule) => !rule.label.trim() || !Number.isInteger(rule.percent) || rule.percent < 1 || (rule.target === 'wallet' && !rule.address?.trim()) || (rule.target === 'defi' && !rule.protocolId)) || allocatedPercent > 100 || JSON.stringify(allocationRules) === JSON.stringify(savedAllocationRules)}>{savingPlan ? 'Saving plan…' : 'Save allocation plan'}</button></div></div>
      </section>
      <section className="treasury-income-card"><div className="panel-heading"><div><span className="page-eyebrow">CONFIRMED RECEIPTS</span><h2>Run your saved plan when you’re ready</h2><p>Only provider-confirmed invoice payments appear here. Select a receipt and approve each wallet action. Veyra never moves funds automatically.</p></div><button type="button" className="button button-outline" onClick={() => void loadTreasury(true)} disabled={refreshing}><RefreshCw size={14} /> Refresh</button></div>{income.length ? <div className="treasury-income-list">{income.map((item) => <article key={item.paymentId}><div><b>{item.invoiceNumber}</b><small>Received {item.amount} {item.currency} · {item.network}{item.settledAt ? ` · ${new Date(item.settledAt).toLocaleDateString()}` : ''}</small><small>Delivered to {shorten(item.recipientAddress)}</small></div><button type="button" className="button button-green button-small" onClick={() => setPendingIncome(item)} disabled={!allocationRules.length || !!runningPaymentId || JSON.stringify(allocationRules) !== JSON.stringify(savedAllocationRules)}>{runningPaymentId === item.paymentId ? 'Running plan…' : 'Run plan'}</button></article>)}</div> : <p className="treasury-empty-copy">There are no confirmed, unallocated invoice receipts. Incoming invoice payments will appear after provider settlement.</p>}</section>
      {incomeRuns.length > 0 && <section className="treasury-income-card"><div className="panel-heading"><div><span className="page-eyebrow">TREASURY HISTORY</span><h2>Allocation runs</h2></div></div><div className="treasury-income-list">{incomeRuns.map((run) => <article key={run.id}><div><b>{run.status.replaceAll('_', ' ')} · {run.sourceAmount} {run.currency}</b><small>{new Date(run.createdAt).toLocaleString()} · {run.network}</small>{run.outputs.map((output, index) => <small key={`${run.id}-${index}`}>{output.label}: {output.amount} {run.currency}{output.transactionHash ? ` · ${shorten(output.transactionHash)}` : ''}</small>)}</div><span className={`status-pill ${run.status === 'completed' ? 'status-success' : run.status === 'partial' ? 'status-error' : 'status-pending'}`}><span />{run.status.replaceAll('_', ' ')}</span></article>)}</div></section>}

    </>
    {pendingIncome && <Modal title={`Allocate ${pendingIncome.invoiceNumber}`} subtitle={`${pendingIncome.amount} ${pendingIncome.currency} · ${pendingIncome.network}`} onClose={() => { if (!runningPaymentId) setPendingIncome(null); }}><div className="form-stack"><p>Review where each share goes. The wallet that received this payment signs and sends the allocations. The unassigned share stays in that wallet.</p><div className="treasury-review-list">{allocationRules.map((rule) => <div key={rule.id}><span>{rule.label} · {rule.percent}%</span><b>{treasuryUnitsAmount(treasuryAmountUnits(pendingIncome.amount, pendingIncome.decimals) * BigInt(rule.percent) / 100n, pendingIncome.decimals)} {pendingIncome.currency}</b><small>{rule.target === 'wallet' ? rule.address : defiProtocols.find((item) => item.id === rule.protocolId)?.name || 'Selected DeFi protocol'}</small></div>)}<div><span>Keep in receiving wallet · {100 - allocationRules.reduce((sum, rule) => sum + rule.percent, 0)}%</span><b>{treasuryUnitsAmount(treasuryAmountUnits(pendingIncome.amount, pendingIncome.decimals) * BigInt(100 - allocationRules.reduce((sum, rule) => sum + rule.percent, 0)) / 100n, pendingIncome.decimals)} {pendingIncome.currency}</b></div></div>{runningPaymentId && <p role="status">Review and approve each wallet request. Do not close this window while transfers are submitting.</p>}<div className="form-actions"><button className="button button-outline" type="button" onClick={() => setPendingIncome(null)} disabled={!!runningPaymentId}>Cancel</button><button className="button button-green" type="button" onClick={() => void executeIncomePlan(pendingIncome)} disabled={!!runningPaymentId || !allocationRules.length}>{runningPaymentId ? 'Waiting for wallet approvals…' : 'Run plan and approve transfers'}</button></div></div></Modal>}
  </AppFrame>;
}

function LegacyTreasuryPage() {
  const query = useGetAllocations({ query: { queryKey: getGetAllocationsQueryKey() } });
  const update = useUpdateAllocations();
  const qc = useQueryClient();
  const privy = usePrivyWallet();
  const [values, setValues] = useState<AllocationsInput | null>(null);
  const [message, setMessage] = useState('');
  const [eligiblePayments, setEligiblePayments] = useState<{ paymentId: string; invoiceNumber: string | null; amount: string; currency: string; assetId: string | null; network: string | null; decimals: number | null; recipientAddress: string | null; settledAt: string; hasSavedPreferences: boolean; preview: { tax: string; savings: string; spending: string; taxPercent: number; savingsPercent: number; spendingPercent: number } | null }[]>([]);
  const [treasuryAssets, setTreasuryAssets] = useState<{ assetId: string; symbol: string; blockchain: string; decimals: number; contractAddress?: string | null }[]>([]);
  const [destinations, setDestinations] = useState({ tax: '', savings: '', spending: '' });
  const [destinationSave, setDestinationSave] = useState('');
  const [submittedTransfers, setSubmittedTransfers] = useState<Record<string, string[]>>(() => { try { return JSON.parse(localStorage.getItem('trezu:treasury-submitted') || '{}'); } catch { return {}; } });
  const [allocationHistory, setAllocationHistory] = useState<{ id: string; invoiceNumber: string; sourceAmount: string; currency: string; taxAmount: string; savingsAmount: string; spendingAmount: string; createdAt: string; transferNetwork?: string | null; transferTxHashes?: string[] | null }[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState('');
  const [applyingPayment, setApplyingPayment] = useState('');
  const [savingsGoals, setSavingsGoals] = useState<{ id: string; name: string; currency: string; targetAmount: string; targetDate: string | null; status: string; contributedAmount: string; remainingAmount: string; progressPercent: number; contributions: { id: string; amount: string; invoiceNumber: string; createdAt: string; movementStatus: string }[] }[]>([]);
  const [savingsSources, setSavingsSources] = useState<{ allocationEventId: string; invoiceNumber: string; currency: string; savingsAmount: string; availableAmount: string; createdAt: string }[]>([]);
  const [savingsLoading, setSavingsLoading] = useState(true);
  const [savingsError, setSavingsError] = useState('');
  const [savingsBusyGoal, setSavingsBusyGoal] = useState('');
  const [goalModal, setGoalModal] = useState(false);
  const reportToday = new Date().toISOString().slice(0, 10);
  const [reportFrom, setReportFrom] = useState(`${reportToday.slice(0, 7)}-01`);
  const [reportTo, setReportTo] = useState(reportToday);
  const [taxReport, setTaxReport] = useState<TaxReserveReport | null>(null);
  const [taxReportLoading, setTaxReportLoading] = useState(false);
  const [taxReportError, setTaxReportError] = useState('');
  const [internalAutomation, setInternalAutomation] = useState<InternalIncomeAutomation>({ enabled: false, updatedAt: null, movementStatus: 'internal_ledger_only' });
  const [internalAutomationLoading, setInternalAutomationLoading] = useState(true);
  const [internalAutomationError, setInternalAutomationError] = useState('');
  const [automationChangeTo, setAutomationChangeTo] = useState<boolean | null>(null);
  useEffect(() => {
    void apiFetch('/api/treasury/destinations').then(async (response) => { const body = await response.json(); if (response.ok) setDestinations({ tax: body.tax || '', savings: body.savings || '', spending: body.spending || '' }); }).catch(() => {});
    void apiFetch('/api/integrations/near-intents/assets').then((response) => response.json()).then((body) => { if (Array.isArray(body.assets)) setTreasuryAssets(body.assets); }).catch(() => {});
  }, []);
  const loadAllocationActivity = async () => {
    setActivityLoading(true); setActivityError('');
    try {
      const [eligibleResponse, historyResponse] = await Promise.all([apiFetch('/api/treasury/allocations/eligible-payments'), apiFetch('/api/treasury/allocations/history')]);
      const eligibleBody = await eligibleResponse.json(); const historyBody = await historyResponse.json();
      if (!eligibleResponse.ok || !historyResponse.ok) throw new Error(eligibleBody.error || historyBody.error || 'Treasury allocation records could not be loaded.');
      setEligiblePayments(eligibleBody); setAllocationHistory(historyBody);
    } catch (error) { setActivityError(error instanceof Error ? error.message : 'Treasury allocation records could not be loaded.'); }
    finally { setActivityLoading(false); }
  };
  useEffect(() => { void loadAllocationActivity(); }, []);
  const loadSavings = async () => {
    setSavingsLoading(true); setSavingsError('');
    try {
      const [goalsResponse, sourcesResponse] = await Promise.all([apiFetch('/api/treasury/savings-goals'), apiFetch('/api/treasury/savings-sources')]);
      const goalsBody = await goalsResponse.json(); const sourcesBody = await sourcesResponse.json();
      if (!goalsResponse.ok || !sourcesResponse.ok) throw new Error(goalsBody.error || sourcesBody.error || 'Savings records could not be loaded.');
      setSavingsGoals(goalsBody); setSavingsSources(sourcesBody);
    } catch (error) { setSavingsError(error instanceof Error ? error.message : 'Savings records could not be loaded.'); }
    finally { setSavingsLoading(false); }
  };
  useEffect(() => { void loadSavings(); }, []);
  const loadInternalAutomation = async () => {
    setInternalAutomationLoading(true); setInternalAutomationError('');
    try { const response = await apiFetch('/api/treasury/automation/internal-income-allocation', { credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Automation settings could not be loaded.'); setInternalAutomation(body); }
    catch (error) { setInternalAutomationError(error instanceof Error ? error.message : 'Automation settings could not be loaded.'); }
    finally { setInternalAutomationLoading(false); }
  };
  useEffect(() => { void loadInternalAutomation(); }, []);
  const saveInternalAutomation = async () => {
    if (automationChangeTo === null) return;
    setInternalAutomationLoading(true); setInternalAutomationError('');
    try {
      const response = await apiFetch('/api/treasury/automation/internal-income-allocation', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: automationChangeTo, expectedUpdatedAt: internalAutomation.updatedAt, expectedPreferencesUpdatedAt: query.data?.updatedAt }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Automation setting could not be updated.');
      setInternalAutomation(body); setAutomationChangeTo(null); setMessage(automationChangeTo ? 'Automatic internal allocation enabled. Confirmed income will be recorded in your ledger using the saved split.' : 'Automatic internal allocation paused.');
      await loadAllocationActivity();
    } catch (error) { setInternalAutomationError(error instanceof Error ? error.message : 'Automation setting could not be updated.'); await loadInternalAutomation(); }
    finally { setInternalAutomationLoading(false); }
  };
  const loadTaxReport = async () => {
    setTaxReportLoading(true); setTaxReportError('');
    try {
      const query = new URLSearchParams({ from: reportFrom, to: reportTo });
      const response = await apiFetch(`/api/treasury/reports/tax-reserves?${query}`, { credentials: 'include' });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Tax reserve report could not be loaded.');
      setTaxReport(body);
    } catch (error) { setTaxReportError(error instanceof Error ? error.message : 'Tax reserve report could not be loaded.'); }
    finally { setTaxReportLoading(false); }
  };
  const exportTaxReport = () => {
    if (!taxReport) return;
    const csvCell = (value: unknown) => { let text = String(value ?? ''); if (/^\s*[=+\-@]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; };
    const rows = [
      ['Veyra tax reserve ledger report', taxReport.from, taxReport.to],
      ['Basis', 'Confirmed internal ledger entries'],
      ['Tax advice', 'No'],
      [],
      ['Currency', 'Opening reserve balance', 'Tax reserve allocated in period', 'Closing reserve balance'],
      ...taxReport.totals.map((total) => [total.currency, total.openingBalance, total.allocatedDuringPeriod, total.closingBalance]),
      [],
      ['Recorded at', 'Invoice', 'Source amount', 'Currency', 'Reserve percentage', 'Tax reserve amount', 'Allocation reference'],
      ...taxReport.entries.map((entry) => [entry.recordedAt, entry.invoiceNumber, entry.sourceAmount, entry.currency, entry.taxPercent, entry.taxReserveAmount, entry.allocationId]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `veyra-tax-reserves-${taxReport.from}-${taxReport.to}.csv`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  useEffect(() => { if (query.data && !values) setValues({ taxPercent: query.data.taxPercent, savingsPercent: query.data.savingsPercent, spendingPercent: query.data.spendingPercent, automationEnabled: query.data.automationEnabled }); }, [query.data, values]);
  const sum = values ? values.taxPercent + values.savingsPercent + values.spendingPercent : 0;
  const savedPlanMatches = !!query.data?.updatedAt && !!values && values.taxPercent === query.data.taxPercent && values.savingsPercent === query.data.savingsPercent && values.spendingPercent === query.data.spendingPercent;
  const change = (key: 'taxPercent' | 'savingsPercent' | 'spendingPercent', value: string) => setValues((old) => old ? { ...old, [key]: Math.max(0, Math.min(100, Number(value) || 0)) } : old);
  const save = () => { if (!values || sum !== 100) return; update.mutate({ data: values }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetAllocationsQueryKey() }); setMessage('Preferences saved. No funds were moved.'); }, onError: () => setMessage('We could not save those preferences. Try again.') }); };
  const applyAllocation = async (paymentId: string, transfer?: { network: string; transactionHashes: string[] }) => {
    setApplyingPayment(paymentId); setActivityError('');
    try {
      if (!query.data?.updatedAt) throw new Error('Save allocation preferences before recording a split.');
      const response = await apiFetch(`/api/treasury/allocations/apply/${paymentId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taxPercent: query.data.taxPercent, savingsPercent: query.data.savingsPercent, spendingPercent: query.data.spendingPercent, updatedAt: query.data.updatedAt, ...(transfer ? { transferNetwork: transfer.network, transferTxHashes: transfer.transactionHashes } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The income allocation could not be recorded.');
      setMessage(transfer ? 'Wallet transfers submitted and their transaction references were saved.' : 'Internal allocation recorded. No funds were moved.');
      await loadAllocationActivity();
      return true;
    } catch (error) { setActivityError(error instanceof Error ? error.message : 'The income allocation could not be recorded.'); }
    finally { setApplyingPayment(''); }
    return false;
  };
  const saveDestinations = async () => {
    setDestinationSave('Saving destinations…');
    try {
      const response = await apiFetch('/api/treasury/destinations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destinations }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not save treasury destinations.');
      setDestinations({ tax: body.tax || '', savings: body.savings || '', spending: body.spending || '' });
      setDestinationSave('Destinations saved for this workspace. Transfers still require wallet approval.');
    } catch (error) { setDestinationSave(error instanceof Error ? error.message : 'Could not save treasury destinations.'); }
  };
  const rememberSubmittedTransfer = (paymentId: string, hashes: string[]) => {
    const next = { ...submittedTransfers, [paymentId]: hashes };
    setSubmittedTransfers(next);
    localStorage.setItem('trezu:treasury-submitted', JSON.stringify(next));
  };
  const sendTreasurySplit = async (payment: typeof eligiblePayments[number]) => {
    const submittedHashes: string[] = [];
    setApplyingPayment(payment.paymentId); setActivityError(''); setMessage('');
    try {
      if (!payment.preview || !payment.assetId || !payment.network || payment.decimals === null || !payment.recipientAddress) throw new Error('This payment is missing its confirmed asset or receiving wallet details. Refresh the page first.');
      if (!query.data?.updatedAt || !savedPlanMatches) throw new Error('Save the allocation percentages before sending.');
      if (submittedTransfers[payment.paymentId]) throw new Error('A transfer was already submitted for this payment. Check its transaction history before doing anything else.');
      const network = payment.network;
      const decimals = payment.decimals;
      const asset = treasuryAssets.find((item) => item.assetId === payment.assetId);
      if (!asset) throw new Error('The settled testnet asset is not in the current provider catalog. Refresh and try again.');
      const outputs = [{ key: 'tax' as const, label: 'Tax', amount: payment.preview.tax }, { key: 'savings' as const, label: 'Savings', amount: payment.preview.savings }, { key: 'spending' as const, label: 'Spending', amount: payment.preview.spending }].filter((item) => Number(item.amount) > 0);
      if (!outputs.length || outputs.some((item) => !destinations[item.key].trim())) throw new Error('Add a destination wallet for every non-zero part of the split.');
      const isNear = payment.network.toLowerCase() === 'near';
      for (const output of outputs) {
        const address = destinations[output.key].trim();
        if (isNear ? !/^[a-z0-9._-]{2,64}$/.test(address) : !/^0x[0-9a-f]{40}$/i.test(address)) throw new Error(`Enter a valid ${payment.network} address for ${output.label}.`);
      }
      const scale = 10n ** BigInt(decimals);
      const toUnits = (amount: string) => { const [whole, fraction = ''] = amount.split('.'); if (!/^\d+$/.test(whole) || fraction.length > decimals) throw new Error('The split amount does not match this token’s precision.'); return (BigInt(whole) * scale + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals))).toString(); };
      const source = isNear ? await connectNearWallet() : privy.privyAddress;
      if (!source) throw new Error(isNear ? 'Connect your NEAR testnet wallet to approve the split.' : 'Your Privy EVM wallet is not ready. Sign in again and retry.');
      if (source.toLowerCase() !== payment.recipientAddress.toLowerCase()) throw new Error(`The invoice was paid to ${payment.recipientAddress}. Sign with that same wallet to move its funds.`);
      if (isNear) {
        const hashes = await sendNearDepositsBatch(asset, outputs.map((item) => ({ depositAddress: destinations[item.key].trim(), amountIn: toUnits(item.amount) })));
        submittedHashes.push(...hashes.filter((hash): hash is string => !!hash));
      } else {
        for (const output of outputs) submittedHashes.push(await privy.sendPrivyDeposit(asset, destinations[output.key].trim(), toUnits(output.amount)));
      }
      rememberSubmittedTransfer(payment.paymentId, submittedHashes);
      const ledgerRecorded = await applyAllocation(payment.paymentId, { network, transactionHashes: submittedHashes });
      setMessage(`Wallet transfer${submittedHashes.length === 1 ? '' : 's'} submitted for ${payment.invoiceNumber || 'this invoice'}.${ledgerRecorded ? ' Transfer references and the accounting split were saved.' : ' The chain submission completed, but Veyra could not save its history; do not resend until you check your wallet activity.'}${submittedHashes.length ? ` Transaction${submittedHashes.length === 1 ? '' : 's'}: ${submittedHashes.join(', ')}` : ' Check the wallet activity for the transaction references.'}`);
      if (!ledgerRecorded) await loadAllocationActivity();
    } catch (error) {
      if (submittedHashes.length) {
        rememberSubmittedTransfer(payment.paymentId, submittedHashes);
        setMessage(`Some wallet transfers were submitted before the flow stopped. Do not retry this invoice split until you check the wallet activity. Transaction references: ${submittedHashes.join(', ') || 'not returned by the wallet'}.`);
      }
      setActivityError(error instanceof Error ? error.message : 'The wallet split could not be submitted.');
    }
    finally { setApplyingPayment(''); }
  };
  const createSavingsGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setSavingsError('');
    try {
      const response = await apiFetch('/api/treasury/savings-goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: String(form.get('name')).trim(), currency: String(form.get('currency')).trim().toUpperCase(), targetAmount: String(form.get('targetAmount')).trim(), targetDate: String(form.get('targetDate') || '') || null }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Savings goal could not be created.');
      setGoalModal(false); await loadSavings();
    } catch (error) { setSavingsError(error instanceof Error ? error.message : 'Savings goal could not be created.'); }
  };
  const updateSavingsGoal = async (goalId: string, status: 'active' | 'paused') => {
    setSavingsBusyGoal(goalId); setSavingsError('');
    try { const response = await apiFetch(`/api/treasury/savings-goals/${goalId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Savings goal could not be updated.'); await loadSavings(); }
    catch (error) { setSavingsError(error instanceof Error ? error.message : 'Savings goal could not be updated.'); }
    finally { setSavingsBusyGoal(''); }
  };
  const contributeToSavingsGoal = async (goalId: string, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const allocationEventId = String(form.get('allocationEventId')); setSavingsBusyGoal(goalId); setSavingsError('');
    try {
      const response = await apiFetch(`/api/treasury/savings-goals/${goalId}/contributions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ allocationEventId, amount: String(form.get('amount')).trim() }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Goal contribution could not be recorded.');
      await Promise.all([loadSavings(), loadAllocationActivity()]);
    } catch (error) { setSavingsError(error instanceof Error ? error.message : 'Goal contribution could not be recorded.'); }
    finally { setSavingsBusyGoal(''); }
  };
  return <AppFrame title="Treasury" eyebrow="PLAN WHAT HAPPENS AFTER YOU GET PAID" action={<Link href="/app/wallets" className="button button-outline"><Wallet size={15} /> View wallet balances</Link>}>
    <div className="treasury-intro"><div><p>Treasury is where you review confirmed invoice income and direct wallet transfers into your own tax, savings, or spending wallets. Veyra never holds the funds; every transfer needs your wallet approval.</p><div className="treasury-intro-links"><Link href="/app/invoices?tab=received">Received invoices <ArrowRight size={13} /></Link><Link href="/app/wallets">Wallet balances <ArrowRight size={13} /></Link><Link href="/app/records">All financial records <ArrowRight size={13} /></Link></div></div><span className="treasury-intro-icon"><Coins size={22} /></span></div><div className="treasury-summary-strip"><article><small>READY TO TRANSFER</small><strong>{eligiblePayments.length}</strong><span>Provider-confirmed invoice payments</span></article><article><small>ALLOCATIONS RECORDED</small><strong>{allocationHistory.length}</strong><span>Accounting records in this workspace</span></article><article><small>SAVINGS GOALS</small><strong>{savingsGoals.length}</strong><span>Track plans alongside wallet transfers</span></article></div>
    <div className="treasury-notice"><span className="notice-shield"><ShieldCheck size={18} /></span><div><b>Your wallet stays in control.</b><p>Treasury prepares direct testnet transfers from the same wallet that received an invoice payment. You review and approve each transfer in your wallet.</p></div><span className="notice-tag">WALLET APPROVAL</span></div>
    {query.isLoading ? <StatePanel kind="loading" title="Loading your preferences" text="Your saved allocation preferences will appear shortly." /> : query.isError ? <StatePanel kind="error" title="Preferences did not load" text="Try again to view your saved allocation preferences." retry={() => query.refetch()} /> : values && <div className="treasury-layout"><section className="allocation-card"><div className="allocation-heading"><div><span className="page-eyebrow">ALLOCATION SPLIT</span><h2>Make a plan that fits.</h2></div><span className="allocation-total">{sum}<small> / 100</small></span></div><p className="allocation-description">Adjust each category. Together, the preference must equal 100%.</p>{(['taxPercent', 'savingsPercent', 'spendingPercent'] as const).map((key, i) => { const labels = ['Tax reserve', 'Savings', 'Spending']; const hints = ['Set aside for obligations', 'Build a buffer over time', 'Available for day-to-day']; return <div className="allocation-control" key={key}><div className="allocation-control-head"><span className={`allocation-dot allocation-dot-${i}`} /><div><b>{labels[i]}</b><small>{hints[i]}</small></div><div className="percent-input"><input aria-label={`${labels[i]} percent`} type="number" min="0" max="100" value={values[key]} onChange={(e) => change(key, e.target.value)} data-testid={`input-${key}`} /><span>%</span></div></div><input className={`allocation-range range-${i}`} type="range" min="0" max="100" value={values[key]} onChange={(e) => change(key, e.target.value)} aria-label={`${labels[i]} slider`} /></div>})}
      <div className={`sum-message ${sum === 100 ? 'sum-valid' : 'sum-invalid'}`}><span>{sum === 100 ? <Check size={15} /> : <CircleHelp size={15} />}</span>{sum === 100 ? 'Your allocation preferences add up to 100%.' : `Your preferences currently total ${sum}%. Adjust them to equal 100%.`}</div>
       <div className="automation-setting"><div><b>Automatic wallet transfers</b><small>Not available. Each transfer needs you to review the recipient and approve in your wallet.</small></div><span className="status-pill status-muted"><span /> Wallet approval required</span></div>
      {message && <div className={`inline-notice ${message.startsWith('Preferences') || message.startsWith('Automatic internal allocation') || message.startsWith('Internal allocation') ? 'notice-success' : 'notice-error'}`}>{message}</div>}
      <button className="button button-green save-allocation" onClick={save} disabled={sum !== 100 || update.isPending} data-testid="button-save-allocations">{update.isPending ? 'Saving preferences…' : 'Save preferences'} <ArrowRight size={15} /></button>
      {query.data?.updatedAt && <div className="updated-at">Last updated {formatDate(query.data.updatedAt)}</div>}
     </section><aside className="allocation-preview treasury-next-steps"><span className="page-eyebrow">HOW THIS CONNECTS</span><h3>From invoice to wallet transfer</h3><ol><li><b>Get paid</b><span>Confirmed invoice income stays at the receiving wallet saved on that invoice.</span></li><li><b>Choose destinations</b><span>Set the wallets for tax, savings, and spending. These are saved in this browser.</span></li><li><b>Review the split</b><span>Check the amount and recipient for every part before approving.</span></li><li><b>Sign in your wallet</b><span>Your wallet submits the testnet transfers. Veyra does not custody money.</span></li></ol><Link href="/app/wallets" className="button button-outline"><Wallet size={14} /> View wallet balances</Link><p className="treasury-boundary-note">Direct same-asset transfers only in this first testnet version. Cross-chain conversion is handled in invoice payment, not Treasury.</p></aside></div>}
    <section className="allocation-history-card"><div className="payment-history-heading"><div><span className="page-eyebrow">WALLET TRANSFERS</span><h2>Move confirmed income</h2></div><button type="button" className="text-button" onClick={() => void loadAllocationActivity()}><RefreshCw size={14} /> Refresh</button></div><p className="form-footnote">Funds stay in your wallet. Choose destination wallets, review each confirmed invoice split, then approve the transfers in your wallet. Testnet only.</p>
      <div className="treasury-destinations"><label>Tax destination wallet<input value={destinations.tax} onChange={(event) => { setDestinations((old) => ({ ...old, tax: event.target.value })); setDestinationSave(''); }} placeholder="Wallet address for the tax portion" autoComplete="off" /></label><label>Savings destination wallet<input value={destinations.savings} onChange={(event) => { setDestinations((old) => ({ ...old, savings: event.target.value })); setDestinationSave(''); }} placeholder="Wallet address for the savings portion" autoComplete="off" /></label><label>Spending destination wallet<input value={destinations.spending} onChange={(event) => { setDestinations((old) => ({ ...old, spending: event.target.value })); setDestinationSave(''); }} placeholder="Wallet address for the spending portion" autoComplete="off" /></label><div><button type="button" className="button button-outline button-small" onClick={() => void saveDestinations()}>Save destinations</button>{destinationSave && <small role="status">{destinationSave}</small>}</div><p className="treasury-destinations-note">Each transfer uses the invoice’s same asset and network. Token payouts may also need native testnet tokens for gas or NEP-141 storage registration.</p></div>
      {activityError && <p className="form-error">{activityError}</p>}
      {activityLoading ? <p className="payment-history-empty">Loading confirmed income…</p> : eligiblePayments.length ? <div className="allocation-income-list">{eligiblePayments.map((payment) => <article className="allocation-income-row" key={payment.paymentId}><div><b>{payment.invoiceNumber || 'Invoice payment'}</b><small>Confirmed {new Date(payment.settledAt).toLocaleDateString()} · {payment.network || 'testnet'} · paid to {payment.recipientAddress || 'address unavailable'}</small><small>{submittedTransfers[payment.paymentId] ? 'Transfer already submitted from this browser. Check the saved transaction references before taking any further action.' : !payment.hasSavedPreferences ? 'Save allocation percentages before preparing the transfer.' : !savedPlanMatches ? 'Save your current percentage edits before sending this split.' : payment.preview ? `Transfer preview: tax ${formatDecimalAmount(payment.currency, payment.preview.tax)}, savings ${formatDecimalAmount(payment.currency, payment.preview.savings)}, spending ${formatDecimalAmount(payment.currency, payment.preview.spending)}` : 'This payment could not be represented at the asset precision.'}</small></div><strong>{formatDecimalAmount(payment.currency, payment.amount)}</strong><div className="treasury-row-actions"><button type="button" className="button button-green button-small" disabled={!payment.hasSavedPreferences || !savedPlanMatches || !payment.preview || !payment.recipientAddress || applyingPayment === payment.paymentId || !!submittedTransfers[payment.paymentId]} onClick={() => void sendTreasurySplit(payment)}>{submittedTransfers[payment.paymentId] ? 'Transfer submitted' : applyingPayment === payment.paymentId ? 'Waiting for wallet approval…' : 'Review and send split'}</button><button type="button" className="text-button" disabled={!payment.hasSavedPreferences || !savedPlanMatches || !payment.preview || applyingPayment === payment.paymentId || !!submittedTransfers[payment.paymentId]} onClick={() => void applyAllocation(payment.paymentId)}>Record split only</button></div></article>)}</div> : <p className="payment-history-empty">No confirmed invoice payments are waiting to be transferred.</p>}
      <div className="allocation-history-heading"><span className="page-eyebrow">ALLOCATION HISTORY</span></div>
      {allocationHistory.length ? <div className="allocation-history-list">{allocationHistory.map((event) => <article className="allocation-history-row" key={event.id}><div><b>{event.invoiceNumber}</b><small>{formatDate(event.createdAt)} · {formatDecimalAmount(event.currency, event.sourceAmount)} split</small></div><span>Tax {formatDecimalAmount(event.currency, event.taxAmount)}</span><span>Savings {formatDecimalAmount(event.currency, event.savingsAmount)}</span><span>Spending {formatDecimalAmount(event.currency, event.spendingAmount)}</span><small>{event.transferTxHashes?.length ? <>{event.transferNetwork} · submitted {event.transferTxHashes.map((hash: string) => <code key={hash}>{hash}</code>)}</> : 'Ledger record only'}</small></article>)}</div> : <p className="payment-history-empty">Wallet split records will appear here after you send or record a split.</p>}
    </section>
    <section className="tax-report-panel"><div className="panel-heading"><div><span className="page-eyebrow">TAX RESERVE REPORT</span><h2>What the ledger recorded.</h2></div><span className="status-pill status-muted"><span /> Internal ledger</span></div><p className="tax-report-intro">Shows recorded reserve allocations and ledger balances only. It does not calculate tax due or provide tax advice.</p><div className="tax-report-controls"><label>From<input type="date" value={reportFrom} onChange={(event) => { setReportFrom(event.target.value); setTaxReport(null); }} /></label><label>To<input type="date" value={reportTo} onChange={(event) => { setReportTo(event.target.value); setTaxReport(null); }} /></label><button className="button button-outline" onClick={() => void loadTaxReport()} disabled={taxReportLoading || !reportFrom || !reportTo}>{taxReportLoading ? 'Preparing report…' : 'Generate report'} <ArrowRight size={14} /></button>{taxReport && <button className="button button-green" onClick={exportTaxReport}><Download size={14} /> Download CSV</button>}</div>{taxReportError && <p className="form-error">{taxReportError}</p>}{taxReport && <><div className="tax-report-summary">{taxReport.totals.length ? taxReport.totals.map((total) => <article key={total.currency}><small>{total.currency} · CLOSING RESERVE</small><b>{total.closingBalance}</b><span>{total.allocatedDuringPeriod} allocated in selected period</span><span>{total.openingBalance} opening balance</span></article>) : <div className="tax-report-empty">No tax reserve ledger balance or allocations were recorded for this period.</div>}</div><div className="tax-report-table-wrap"><table><thead><tr><th>RECORDED</th><th>INVOICE</th><th>INCOME</th><th>RESERVE %</th><th>TAX RESERVE</th></tr></thead><tbody>{taxReport.entries.map((entry) => <tr key={entry.allocationId}><td>{formatDate(entry.recordedAt)}</td><td>{entry.invoiceNumber}</td><td>{entry.sourceAmount} {entry.currency}</td><td>{entry.taxPercent}%</td><td>{entry.taxReserveAmount} {entry.currency}</td></tr>)}</tbody></table>{!taxReport.entries.length && <p className="tax-report-empty">No reserve allocations were recorded within these dates.</p>}</div><p className="form-footnote">Report basis: confirmed ledger entries through {taxReport.to}. Allocations are internal accounting records, not transfers.</p></>}</section>
    <section className="savings-goals-card"><div className="payment-history-heading"><div><span className="page-eyebrow">SAVINGS GOALS</span><h2>Give savings a purpose.</h2></div><button className="button button-green button-small" onClick={() => { setSavingsError(''); setGoalModal(true); }}><Plus size={14} /> New goal</button></div><p className="form-footnote">Goal progress is based on internal ledger allocations from confirmed income. It does not represent a separate account or external transfer.</p>
      {savingsError && <p className="form-error">{savingsError}</p>}
      {savingsLoading ? <p className="payment-history-empty">Loading savings goals…</p> : !savingsGoals.length ? <p className="payment-history-empty">Create a goal, then assign savings from a confirmed income allocation.</p> : <div className="savings-goals-list">{savingsGoals.map((goal) => {
        const matchingSources = savingsSources.filter((source) => source.currency === goal.currency);
        return <article className="savings-goal-card" key={goal.id}><div className="savings-goal-head"><div><span className="page-eyebrow">{goal.currency} GOAL</span><h3>{goal.name}</h3></div><span className={`status-pill ${goal.status === 'active' ? 'status-pending' : goal.status === 'completed' ? 'status-success' : 'status-muted'}`}><span />{goal.status}</span></div>
          <div className="savings-goal-numbers"><strong>{formatDecimalAmount(goal.currency, goal.contributedAmount)}</strong><span>of {formatDecimalAmount(goal.currency, goal.targetAmount)}</span><b>{Math.min(goal.progressPercent, 100).toFixed(1)}%</b></div><div className="savings-progress"><span style={{ width: `${Math.min(goal.progressPercent, 100)}%` }} /></div><div className="savings-goal-meta"><span>{formatDecimalAmount(goal.currency, goal.remainingAmount)} remaining</span><span>{goal.targetDate ? `Target ${formatDate(goal.targetDate)}` : 'No target date'}</span></div>
          {goal.status === 'active' && matchingSources.length > 0 && <form className="savings-contribute-form" onSubmit={(event) => void contributeToSavingsGoal(goal.id, event)}><label>From confirmed savings<select name="allocationEventId" required defaultValue="">{matchingSources.map((source) => <option key={source.allocationEventId} value={source.allocationEventId}>{source.invoiceNumber} · {formatDecimalAmount(source.currency, source.availableAmount)} available</option>)}</select></label><label>Amount<input name="amount" required type="text" inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,41})(?:\.[0-9]{1,36})?" placeholder="0.00" /></label><button className="button button-outline button-small" disabled={savingsBusyGoal === goal.id}>{savingsBusyGoal === goal.id ? 'Recording…' : 'Add to goal'}</button></form>}
          {goal.status === 'active' && matchingSources.length === 0 && <p className="form-footnote savings-source-note">Record an income split with a savings allocation in {goal.currency} to contribute to this goal.</p>}
          <div className="savings-goal-actions">{goal.status !== 'completed' && <button type="button" className="text-button" disabled={savingsBusyGoal === goal.id} onClick={() => void updateSavingsGoal(goal.id, goal.status === 'paused' ? 'active' : 'paused')}>{goal.status === 'paused' ? 'Resume goal' : 'Pause goal'}</button>}</div>
          {goal.contributions.length > 0 && <details className="savings-contribution-history"><summary>Contribution history ({goal.contributions.length})</summary>{goal.contributions.map((item) => <div key={item.id}><span>{item.invoiceNumber} · {formatDate(item.createdAt)}</span><b>{formatDecimalAmount(goal.currency, item.amount)}</b></div>)}</details>}
        </article>;
      })}</div>}
    </section>
    {goalModal && <Modal title="Create a savings goal" subtitle="Track progress from savings amounts already recorded in your Veyra ledger." onClose={() => setGoalModal(false)}><form className="form-stack" onSubmit={(event) => void createSavingsGoal(event)}><label>Goal name<input name="name" required maxLength={120} placeholder="Emergency fund" /></label><div className="form-pair"><label>Target amount<input name="targetAmount" required type="text" inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,41})(?:\.[0-9]{1,36})?" placeholder="0.00" /></label><label>Currency<input name="currency" required minLength={2} maxLength={12} defaultValue="USDC" /></label></div><label>Target date <span className="optional-label">OPTIONAL</span><input type="date" name="targetDate" /></label><p className="form-footnote">Contributions are internal accounting entries. Veyra will not claim that these funds were moved into a separate account.</p><div className="form-actions"><button type="button" className="button button-outline" onClick={() => setGoalModal(false)}>Cancel</button><button className="button button-green">Create goal <ArrowRight size={15} /></button></div></form></Modal>}
    {automationChangeTo !== null && <Modal title={automationChangeTo ? 'Enable automatic internal allocation?' : 'Pause automatic internal allocation?'} subtitle="This setting controls how confirmed invoice income is recorded in your Veyra ledger." onClose={() => { if (!internalAutomationLoading) setAutomationChangeTo(null); }}><div className="form-stack"><p>{automationChangeTo ? 'Each newly confirmed and matched invoice payment will be split using the saved percentages. The entries are internal accounting records. No funds will be transferred.' : 'New confirmed invoice payments will stop receiving automatic split entries. Existing ledger records remain unchanged.'}</p>{internalAutomationError && <p className="form-error">{internalAutomationError}</p>}<div className="form-actions"><button type="button" className="button button-outline" onClick={() => setAutomationChangeTo(null)} disabled={internalAutomationLoading}>Cancel</button><button type="button" className="button button-green" onClick={() => void saveInternalAutomation()} disabled={internalAutomationLoading}>{internalAutomationLoading ? 'Saving…' : automationChangeTo ? 'Enable internal allocation' : 'Pause allocation'}</button></div></div></Modal>}
  </AppFrame>;
}

type VendorReviewApplication = { id: string; applicantUserId: string; businessName: string; country: string; currency: string; paymentMethods: string[]; status: 'pending' | 'approved' | 'declined'; reviewNote: string | null; reviewedAt: string | null; createdAt: string };
type VendorOfferView = { id: string; vendorId: string; vendorName: string; country: string; vendorRating: number | null; completedTrades: number; assetId: string; assetSymbol: string; assetNetwork: string; currency: string; paymentMethods: string[]; exchangeRate: string; availableLiquidity: string; minimumAmount: string; maximumAmount: string; status: 'active' | 'paused'; };
type SupportedAssetView = { assetId: string; symbol: string; blockchain: string; decimals: number };

function ExchangePage() {
  return <AppFrame title="Local exchange" eyebrow="COMING SOON">
    <div className="page-intro"><p>Local exchange is not open yet. Veyra is preparing this service for a future release.</p><span className="intro-stamp">COMING SOON</span></div>
    <section className="coming-soon-panel"><span className="coming-soon-label">LOCAL EXCHANGE</span><h2>Access local currency<br />through trusted providers.</h2><p>When this service launches, you will be able to explore local exchange options here. No trades or settlement are available through Veyra yet.</p><span className="coming-soon-pill">Coming soon</span></section>
  </AppFrame>;
}
function AdminVendorReviewPage() {
  const profile = useGetProfile({ query: { queryKey: getGetProfileQueryKey() } });
  const [applications, setApplications] = useState<VendorReviewApplication[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [selectedDecline, setSelectedDecline] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const load = async () => {
    try { const response = await apiFetch('/api/admin/vendor-applications', { credentials: 'include' }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not load applications.'); setApplications(body); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not load applications.'); }
  };
  useEffect(() => { if (profile.data?.role === 'platform_admin') void load(); }, [profile.data?.role]);
  const decide = async (applicationId: string, decision: 'approve' | 'decline') => {
    setBusy(applicationId); setMessage('');
    try {
      const response = await apiFetch(`/api/admin/vendor-applications/${applicationId}/${decision}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(decision === 'decline' ? { reason: declineReason } : {}) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not save this review.');
      setMessage(decision === 'approve' ? 'Application approved and a vendor listing was created.' : 'Application declined and the decision was recorded.'); setSelectedDecline(''); setDeclineReason(''); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save this review.'); }
    finally { setBusy(''); }
  };
  if (profile.isLoading) return <AppFrame title="Vendor review" eyebrow="PLATFORM ADMINISTRATION"><StatePanel kind="loading" title="Checking administrator access" text="Loading your permissions." /></AppFrame>;
  if (profile.data?.role !== 'platform_admin') return <AppFrame title="Vendor review" eyebrow="PLATFORM ADMINISTRATION"><StatePanel kind="error" title="Administrator access required" text="This area is available only to platform administrators." /></AppFrame>;
  const pending = applications.filter((application) => application.status === 'pending');
  return <AppFrame title="Vendor review" eyebrow="PLATFORM ADMINISTRATION">
    <div className="page-intro"><p>Review applications before vendors are listed. Approval publishes the applicant's submitted listing details, not an independent guarantee of trustworthiness.</p><span className="intro-stamp"><ShieldCheck size={17} /> ADMIN REVIEW</span></div>
    {message && <div className={`inline-notice ${message.includes('could not') || message.includes('required') ? 'notice-error' : 'notice-success'}`}><span>{message}</span><button onClick={() => setMessage('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    <div className="admin-review-summary"><b>{pending.length}</b><span>pending applications</span><button className="text-button" onClick={() => void load()}>Refresh <ArrowRight size={14} /></button></div>
    {applications.length === 0 ? <EmptyState icon={<ShieldCheck size={22} />} title="No vendor applications yet." text="New vendor applications will appear here for review." /> : <div className="admin-vendor-list">{applications.map((application) => <article className="admin-vendor-card" key={application.id}><div className="admin-vendor-head"><div><span className="page-eyebrow">APPLICATION · {application.id.slice(0, 8).toUpperCase()}</span><h2>{application.businessName}</h2></div><span className={`status-pill ${application.status === 'pending' ? 'status-pending' : application.status === 'approved' ? 'status-paid' : 'status-error'}`}><span />{application.status}</span></div><div className="admin-vendor-details"><span>{countryName(application.country)} · {application.currency}</span><span>{application.paymentMethods.join(' · ')}</span><span>Submitted {formatDate(application.createdAt)}</span></div><div className="admin-vendor-details"><span>Applicant account: {application.applicantUserId}</span></div>{application.reviewNote && <p className="admin-review-note">Previous decision note: {application.reviewNote}</p>}{application.status === 'pending' && <div className="admin-vendor-actions"><button className="button button-green" onClick={() => void decide(application.id, 'approve')} disabled={!!busy}>Approve and list</button><button className="button button-outline" onClick={() => { setSelectedDecline(application.id); setDeclineReason(''); }} disabled={!!busy}>Decline</button></div>}{selectedDecline === application.id && <div className="admin-decline-box"><label>Reason for decision<textarea value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} maxLength={1000} rows={3} placeholder="Explain what is missing or needs correction." /></label><div><button className="button button-outline" onClick={() => setSelectedDecline('')}>Cancel</button><button className="button button-dark" onClick={() => void decide(application.id, 'decline')} disabled={!!busy || !declineReason.trim()}>Record decline</button></div></div>}</article>)}</div>}
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>Review is not a fraud guarantee.</b> The current application captures business name, country, currency, and declared payment methods. Identity and account ownership verification need a separate verified provider workflow.</span></div>
  </AppFrame>;
}

function countryName(code: string) { const countries: Record<string, string> = { UG: 'Uganda', KE: 'Kenya', NG: 'Nigeria', GH: 'Ghana', US: 'United States' }; return countries[code] || code; }

function RecordsPage() {
  const records = useGetRecords({ query: { queryKey: getGetRecordsQueryKey() } });
  const [search, setSearch] = useState('');
  const [checkingPaymentId, setCheckingPaymentId] = useState('');
  const [statusCheckMessage, setStatusCheckMessage] = useState('');
  const checkPaymentStatus = async (paymentId: string) => {
    setCheckingPaymentId(paymentId); setStatusCheckMessage('');
    try {
      const response = await apiFetch(`/api/integrations/near-intents/status?paymentId=${encodeURIComponent(paymentId)}`, { credentials: 'include' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not check this quote status.');
      await records.refetch();
      setStatusCheckMessage(`Quote ${paymentId.slice(0, 8)} status refreshed: ${String(body.providerStatus || body.status || 'updated').replaceAll('_', ' ')}.`);
    } catch (error) {
      setStatusCheckMessage(error instanceof Error ? error.message : 'Could not check this quote status.');
    } finally { setCheckingPaymentId(''); }
  };
  const filtered = records.data?.filter((r) => `${r.title} ${r.recordType} ${r.status}`.toLowerCase().includes(search.toLowerCase())) || [];
  return <AppFrame title="All records" eyebrow="YOUR ACTUAL FINANCIAL RECORDS">
    <div className="page-intro"><p>Invoices you created or received, confirmed payments, and finance activity saved to your workspace.</p><span className="intro-stamp"><BriefcaseBusiness size={17} /> RECORDS</span></div>
    <div className="records-toolbar"><label className="records-search"><Search size={16} /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search records" aria-label="Search records" data-testid="input-search-records" /></label><span className="records-count">{records.data?.length ?? 0} records</span></div>
    {statusCheckMessage && <div className="inline-notice"><span>{statusCheckMessage}</span><button onClick={() => setStatusCheckMessage('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    {records.isLoading ? <StatePanel kind="loading" title="Loading records" text="Your financial record list is on its way." /> : records.isError ? <StatePanel kind="error" title="Records did not load" text="Your financial records are safe. Try loading them again." retry={() => records.refetch()} /> : !records.data?.length ? <EmptyState icon={<BriefcaseBusiness size={22} />} title="Your records will live here." text="Invoice drafts, payroll profiles, savings activity, allocation entries, and vendor applications will appear in this list." /> : !filtered.length ? <EmptyState icon={<Search size={22} />} title="Nothing found for that search." text="Try a different title or record type." action={<button className="button button-outline" onClick={() => setSearch('')}>Clear search</button>} /> : <div className="records-list">{filtered.map((record) => { const statusLower = record.status.toLowerCase(); const pending = statusLower.includes('pending') || statusLower.includes('waiting for deposit') || statusLower === 'processing' || record.status === 'KNOWN_DEPOSIT_TX'; const canCheckQuote = record.recordType === 'near_intent_payment' && !!record.quoteId && (pending || statusLower === 'quote expired'); return <article className="record-row" key={record.id} data-testid={`row-record-${record.id}`}><span className={`record-type-icon type-${record.recordType}`}>{record.recordType === 'invoice' ? <FileText size={17} /> : record.recordType === 'payroll_profile' || record.recordType === 'payroll_cycle' || record.recordType === 'payroll_payment' ? <Users size={17} /> : record.recordType === 'near_intent_payment' || record.recordType === 'treasury_allocation' || record.recordType === 'savings_goal_contribution' ? <Coins size={17} /> : <Globe2 size={17} />}</span><span className="record-main"><b>{record.title}</b><small>{recordTypeName(record.recordType)} <span>·</span> Created {formatDate(record.createdAt)}</small>{record.detail && <small className="record-payment-detail">{record.detail}</small>}{record.quoteId && <small className="record-payment-detail">Quote reference: {record.quoteId}</small>}{record.depositAddress && <div className="record-deposit"><code title={record.depositAddress}>{record.depositAddress}</code><button type="button" className="button button-outline button-small" onClick={() => void navigator.clipboard.writeText(record.depositAddress!)}><Copy size={13} /> Copy deposit address</button></div>}{record.transactionLinks?.length ? <div className="record-transaction-links">{record.transactionLinks.map((link, index) => <a key={`${record.id}-tx-${index}`} href={link.url} target="_blank" rel="noreferrer"><span>{link.label}</span><code title={link.hash}>{link.hash}</code><ExternalLink size={13} /></a>)}</div> : null}</span><span className={`status-pill ${statusLower === 'draft' ? 'status-draft' : pending ? 'status-pending' : record.status === 'Provider confirmed' ? 'status-paid' : 'status-muted'}`}><span />{record.status}</span>{canCheckQuote && <button type="button" className="button button-outline button-small" onClick={() => void checkPaymentStatus(record.quoteId!)} disabled={!!checkingPaymentId}>{checkingPaymentId === record.quoteId ? 'Checking…' : 'Check status'}</button>}<span className="record-date">{formatDate(record.createdAt)}</span></article>; })}</div>}
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>Actual records only.</b> This list combines your workspace records with invoices addressed to your account. Payment entries appear only after NEAR Intents confirms settlement.</span></div>
  </AppFrame>;
}
function recordTypeName(type: string) { return type === 'payroll_profile' ? 'Payroll profile' : type === 'payroll_cycle' ? 'Payroll cycle' : type === 'payroll_payment' ? 'Employee payment' : type === 'vendor_application' ? 'Vendor application' : type === 'near_intent_payment' ? 'Cross-chain payment' : type === 'treasury_allocation' ? 'Income allocation' : type === 'savings_goal_contribution' ? 'Savings goal contribution' : 'Invoice'; }

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

type LinkedWallet = { id: string; network: string; address: string; createdAt: string; provider?: string | null; isPrivy?: boolean };
type NearTokenBalance = { assetId: string; symbol: string; decimals: number; balance: string | null };
type NearWalletBalance = { nativeNear: string | null; tokens: NearTokenBalance[] };

function formatWalletUnits(value: string | null, decimals: number): string {
  if (value === null) return 'Unavailable';
  if (!/^\d+$/.test(value)) return 'Unavailable';
  const units = BigInt(value);
  const places = Math.min(decimals, 8);
  const divisor = 10n ** BigInt(Math.max(0, decimals - places));
  const displayedUnits = units / divisor;
  const scale = 10n ** BigInt(places);
  const whole = displayedUnits / scale;
  const fraction = (displayedUnits % scale).toString().padStart(places, '0').replace(/0+$/, '');
  if (units > 0n && displayedUnits === 0n) return `<0.${'0'.repeat(Math.max(0, places - 1))}1`;
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function WalletsPage() {
  const privy = usePrivyWallet();
  const { walletProvisioningError } = useAuth();
  const [wallets, setWallets] = useState<LinkedWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const [nearProvisioningConfigured, setNearProvisioningConfigured] = useState(true);
  const [nearBalances, setNearBalances] = useState<Record<string, NearWalletBalance>>({});
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balanceError, setBalanceError] = useState('');
  const visibleWallets = useMemo(() => {
    const savedWallets = wallets.map((wallet) => wallet.provider === 'privy' ? { ...wallet, isPrivy: true } : wallet);
    if (!privy.privyAddress) return savedWallets;
    const address = privy.privyAddress.toLowerCase();
    const alreadyListed = savedWallets.some((wallet) => wallet.address.toLowerCase() === address);
    if (alreadyListed) return savedWallets.map((wallet) => wallet.address.toLowerCase() === address ? { ...wallet, isPrivy: true } : wallet);
    return [{ id: `privy-${address}`, network: 'evm:11155111', address: privy.privyAddress, createdAt: '', provider: 'privy', isPrivy: true }, ...savedWallets];
  }, [wallets, privy.privyAddress]);
  const refresh = useCallback(async () => {
    setLoading(true); setBalancesLoading(true); setError(''); setBalanceError('');
    try {
      const response = await apiFetch('/api/auth/wallets'); const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load your wallets.');
      setWallets(data.wallets || []);
      setNearProvisioningConfigured(data.nearWalletProvisioningConfigured !== false);
      try {
        const balanceResponse = await apiFetch('/api/auth/wallets/balances');
        const balanceData = await balanceResponse.json();
        if (!balanceResponse.ok) throw new Error(balanceData.error || 'Balances could not be refreshed.');
        setNearBalances(balanceData.balances || {});
      } catch (reason) {
        setBalanceError(reason instanceof Error ? reason.message : 'NEAR testnet balances could not be refreshed.');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load your wallets.'); }
    finally { setLoading(false); setBalancesLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const connect = async (kind: 'evm' | 'privy') => {
    setBusy(true); setError(''); setNotice('');
    try {
      const wallet = kind === 'privy' ? await privy.linkPrivyWallet() : privy.privyEnabled && privy.privyAuthenticated && privy.privyAddress && !getEvmWallet() ? await privy.linkPrivyWallet() : await linkEvmWalletToTrezu();
      setNotice(`${wallet.address} is saved in your wallet list.`); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The wallet could not be added.'); }
    finally { setBusy(false); }
  };
  const unlink = async (wallet: LinkedWallet) => {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await apiFetch(`/api/auth/wallets/${wallet.id}`, { method: 'DELETE' }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not remove this wallet from Veyra.');
      setNotice('Wallet removed from your Veyra list.'); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove this wallet from Veyra.'); }
    finally { setBusy(false); }
  };
  const networkName = (network: string) => ({ 'near:testnet': 'NEAR Testnet', 'evm:11155111': 'Ethereum Sepolia', 'evm:421614': 'Arbitrum Sepolia', 'evm:84532': 'Base Sepolia', 'evm:97': 'BNB Chain Testnet', 'evm:1313161555': 'Aurora Testnet', 'evm:43113': 'Avalanche Fuji' }[network] || network);
  const explorer = (wallet: LinkedWallet) => {
    if (wallet.network === 'near:testnet') return `https://testnet.nearblocks.io/address/${encodeURIComponent(wallet.address)}`;
    const chainId = wallet.network.startsWith('evm:') ? wallet.network.slice(4) : '';
    const base = ({ '11155111': 'https://sepolia.etherscan.io/address/', '421614': 'https://sepolia.arbiscan.io/address/', '84532': 'https://sepolia.basescan.org/address/', '97': 'https://testnet.bscscan.com/address/', '1313161555': 'https://explorer.testnet.aurora.dev/address/', '43113': 'https://testnet.snowtrace.io/address/' } as Record<string, string>)[chainId];
    return base ? `${base}${wallet.address}` : null;
  };
  const copyAddress = async (address: string) => {
    try { await navigator.clipboard.writeText(address); setCopied(address); setNotice('Wallet address copied.'); window.setTimeout(() => setCopied(''), 1800); }
    catch { setError('This browser could not copy the wallet address. Select and copy it manually.'); }
  };
  return <AppFrame title="Wallets" eyebrow="YOUR TESTNET ADDRESSES" action={<button type="button" className="button button-outline" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} /> Refresh wallets</button>}>
    <div className="page-intro"><p>Your embedded EVM wallet is created with your Privy account. Any previously saved NEAR addresses remain listed below for copying and testnet explorer access.</p><span className="intro-stamp"><Wallet size={17} /> WALLET ACCESS</span></div>
    {error && <div className="inline-notice notice-error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={15} /></button></div>}
    {notice && <div className="inline-notice notice-success" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    {!loading && walletProvisioningError && !visibleWallets.some((wallet) => wallet.network === 'near:testnet') && <div className="inline-notice notice-error" role="alert"><span>{walletProvisioningError}</span></div>}
    {!loading && !walletProvisioningError && nearProvisioningConfigured === false && !visibleWallets.some((wallet) => wallet.network === 'near:testnet') && <div className="inline-notice notice-error" role="status"><span>Automatic NEAR wallet creation needs the backend Privy App Secret.</span></div>}
    <section className="wallet-create-panel"><div><span className="page-eyebrow">AUTOMATIC WALLET ACCESS</span><h2>Your account wallets</h2><p>Your EVM wallet is provisioned through your Privy account. Previously saved NEAR addresses remain visible; Privy NEAR addresses appear here when provisioning is configured.</p>{privy.privyEnabled && !privy.privyReady && <p className="form-footnote" role="status">{privy.privyError ? `Privy startup error: ${privy.privyError}` : 'Loading your account wallets…'}</p>}</div><div className="wallet-create-actions">{!privy.privyEnabled && <span className="wallet-count" role="status">Privy is not configured for this app</span>}{privy.privyAuthenticated && <span className="wallet-count" role="status">{privy.privyAddress ? 'Embedded EVM wallet ready' : 'Creating your embedded EVM wallet…'}</span>}</div></section>
    <section className="wallet-directory"><div className="panel-heading"><div><span className="page-eyebrow">YOUR PERSONAL WALLETS</span><h2>Your wallets</h2><p>Embedded EVM wallets appear automatically. NEAR Testnet balances include native NEAR and Tidepool test tokens.</p></div><span className="wallet-count">{visibleWallets.length} {visibleWallets.length === 1 ? 'wallet' : 'wallets'}</span></div>
      {balanceError && <p className="wallet-balance-error" role="status">{balanceError}</p>}
      {loading ? <StatePanel kind="loading" title="Loading your wallets" text="Your saved testnet addresses will appear here." /> : visibleWallets.length ? <div className="wallet-directory-list">{visibleWallets.map((wallet) => { const explorerUrl = explorer(wallet); const nearBalance = wallet.network === 'near:testnet' ? nearBalances[wallet.address.toLowerCase()] : undefined; return <article className="wallet-directory-row" key={wallet.id}><div className="wallet-directory-details"><strong>{wallet.isPrivy ? wallet.network === 'near:testnet' ? 'Privy NEAR wallet' : 'Privy EVM wallet' : networkName(wallet.network)}</strong><code>{wallet.address}</code><small>{wallet.isPrivy ? 'Managed by Privy' : `Added ${formatDate(wallet.createdAt)}`}</small>{wallet.network === 'near:testnet' && <div className="wallet-asset-balances"><span className="wallet-asset-balances-title">{balancesLoading ? 'Checking NEAR Testnet balances…' : 'NEAR TESTNET ASSETS'}</span>{nearBalance && <div className="wallet-asset-balance-grid"><div className="wallet-asset-balance"><small>NEAR</small><strong>{formatWalletUnits(nearBalance.nativeNear, 24)}</strong></div>{nearBalance.tokens.map((token) => <div className="wallet-asset-balance" key={token.assetId}><small>{token.symbol}</small><strong>{formatWalletUnits(token.balance, token.decimals)}</strong></div>)}</div>}{!balancesLoading && !nearBalance && <small>Balances haven’t loaded yet.</small>}</div>}</div><div className="wallet-directory-actions"><button type="button" className="button button-outline button-small" onClick={() => void copyAddress(wallet.address)}><Copy size={14} />{copied === wallet.address ? 'Copied' : 'Copy address'}</button>{explorerUrl && <a className="button button-outline button-small" href={explorerUrl} target="_blank" rel="noreferrer">View activity <ExternalLink size={13} /></a>}{!wallet.isPrivy && <button type="button" className="text-button" disabled={busy} onClick={() => void unlink(wallet)}>Remove</button>}</div></article>; })}</div> : <EmptyState icon={<Wallet size={22} />} title={privy.privyAuthenticated ? 'Creating your embedded EVM wallet…' : 'Your account wallets will appear here.'} text={privy.privyAuthenticated ? 'Privy is still provisioning the wallet for this account. It will appear here automatically.' : 'Your wallets are created with your Privy account and shown here automatically.'} />}
    </section>
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>You control the wallet.</b> Veyra stores the public address only. It cannot see private keys or move funds without wallet approval.</span></div>
  </AppFrame>;
}

function AccountPage() {
  const { user } = useAuth();
  const privy = usePrivyWallet();
  const [nearAddress, setNearAddress] = useState('');
  const [evmAddress, setEvmAddress] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([apiFetch('/api/auth/wallets'), apiFetch('/api/personal-profile/preferences')]).then(async ([walletResponse, preferenceResponse]) => {
      const [walletBody, preferenceBody] = await Promise.all([walletResponse.json(), preferenceResponse.json()]);
      if (!walletResponse.ok) throw new Error(walletBody.error || 'Your wallets could not be loaded.');
      if (!preferenceResponse.ok) throw new Error(preferenceBody.error || 'Your personal settings could not be loaded.');
      if (!active) return;
      const nearWallet = (walletBody.wallets || []).find((wallet: LinkedWallet) => wallet.network === 'near:testnet' && wallet.provider === 'privy')?.address || '';
      const saved = preferenceBody.defaultReceiveAddresses || {};
      setNearAddress(saved.near || nearWallet);
      setEvmAddress(saved.evm || privy.privyAddress || '');
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Your personal profile could not be loaded.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [privy.privyAddress]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); setNotice('');
    try {
      const response = await apiFetch('/api/personal-profile/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultReceiveAddresses: { near: nearAddress, evm: evmAddress } }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Your profile settings could not be saved.');
      setNotice('Your receiving wallet defaults are saved to your personal profile and will be used in future invoices across your workspaces.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Your profile settings could not be saved.'); }
    finally { setSaving(false); }
  };
  return <AppFrame title="Personal profile" eyebrow="MINE · ACCOUNT-WIDE SETTINGS">
    <div className="personal-profile-layout">
      <section className="account-security-card personal-identity-card"><div><span className="page-eyebrow">YOUR VEYRA IDENTITY</span><h2>{user?.name}</h2><p>{user?.email}</p><p className="form-footnote">This profile belongs to you. It stays the same when you move between freelance work and organizations.</p></div><span className="account-verified"><BadgeCheck size={16} /> Signed in</span></section>
      <form className="personal-profile-settings" onSubmit={save}><div className="section-heading"><div><span className="page-eyebrow">PAYMENT DEFAULTS</span><h2>Where should your invoices be paid?</h2><p>These are your personal receiving addresses. New invoices use the matching default; each invoice can still use a different address.</p></div></div>
        {loading ? <StatePanel kind="loading" title="Loading your profile" text="Getting your wallet addresses and saved defaults." /> : <div className="personal-address-grid"><label>NEAR testnet receiving address<input value={nearAddress} onChange={(event) => setNearAddress(event.target.value)} maxLength={128} placeholder="Your Privy NEAR account" autoComplete="off" /><small>Used when an invoice settles to a NEAR testnet asset.</small></label><label>EVM receiving address<input value={evmAddress} onChange={(event) => setEvmAddress(event.target.value)} maxLength={42} placeholder="Your Privy EVM wallet" autoComplete="off" /><small>Used for supported EVM testnet assets, including Base Sepolia.</small></label></div>}
        {error && <p className="form-error" role="alert">{error}</p>}{notice && <div className="inline-notice notice-success" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15} /></button></div>}
        <div className="personal-profile-actions"><button className="button button-green" disabled={loading || saving}>{saving ? 'Saving profile…' : 'Save personal settings'}</button><Link href="/app/wallets" className="button button-outline"><Wallet size={15} /> View wallets</Link></div>
      </form>
      <section className="account-separation-note"><strong>Your workspaces use these defaults</strong><p>Freelance invoices and organization workflows remain separate. Updating this profile only changes your personal receiving defaults; it does not alter an invoice already sent or a payment already approved.</p></section>
    </div>
  </AppFrame>;
}

function PageMetadata() {
  const [location] = useLocation();

  useEffect(() => {
    const pageTitle = location.startsWith('/app')
      ? 'Finance workspace'
      : location.startsWith('/pay/')
        ? 'Invoice payment'
        : location.startsWith('/sign-in')
          ? 'Sign in'
          : location.startsWith('/sign-up')
            ? 'Create your account'
            : 'Global payments and finance workspace';
    document.title = `${pageTitle} | Veyra Finance`;
  }, [location]);

  return null;
}

function ScrollToTop() {
  const [location] = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
    for (const element of [document.documentElement, document.body, document.querySelector('.app-main'), document.querySelector('.page-content')]) {
      if (element instanceof HTMLElement) element.scrollTop = 0;
    }
  }, [location]);

  return null;
}

function Routes() {
  const { user } = useAuth();
  return <>
    <PageMetadata />
    <Switch>
      <Route path="/sign"><PrivyNearSignPage /></Route>
      <Route path="/"><HomePage /></Route>
      <Route path="/verify-email"><VerifyEmailPage /></Route>
      <Route path="/forgot-password"><ForgotPasswordPage /></Route>
      <Route path="/reset-password"><ResetPasswordPage /></Route>
      <Route path="/sign-in/*?">{user ? <Redirect to={postSignInPath()} /> : <SignInPage />}</Route>
      <Route path="/sign-up/*?">{user ? <Redirect to="/app" /> : <SignUpPage />}</Route>
      <Route path="/employee-invite/:token">{(params: { token: string }) => <EmployeeInvitationPage token={params.token} />}</Route>
      <Route path="/create-invoice"><GuestInvoicePage /></Route>
      <Route path="/pay/:token">{(params: { token: string }) => <PublicInvoicePage token={params.token} />}</Route>
      <Route path="/app"><Protected><WorkspaceSetup /></Protected></Route>
      <Route path="/app/account"><Protected><AccountPage /></Protected></Route>
      <Route path="/app/wallets"><Protected><WalletsPage /></Protected></Route>
      <Route path="/app/employee"><Protected><Redirect to="/app" /></Protected></Route>
      <Route path="/app/organization/new"><Protected><CreateOrganizationPage /></Protected></Route>
      <Route path="/app/organization"><Protected><OrganizationRoutePage /></Protected></Route>
      <Route path="/app/invoices"><Protected><InvoicesPage /></Protected></Route>
      <Route path="/app/invoices/:invoiceId">{(params: { invoiceId: string }) => <Protected><InvoiceDetailPage invoiceId={params.invoiceId} /></Protected>}</Route>
      <Route path="/app/payables"><Protected><BillsToPayPage /></Protected></Route>
      <Route path="/app/payroll"><Protected><PayrollRoutePage /></Protected></Route>
      <Route path="/app/treasury"><Protected><TreasuryPage /></Protected></Route>
      <Route path="/app/exchange"><Protected><ExchangePage /></Protected></Route>
      <Route path="/app/admin/vendors"><Protected><AdminVendorReviewPage /></Protected></Route>
      <Route path="/app/records"><Protected><RecordsPage /></Protected></Route>
      <Route><NotFound /></Route>
    </Switch>
  </>;
}

function PrivyNearSignPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [session, setSession] = useState<SignPageSession | null>(null);
  const [signing, setSigning] = useState(false);
  useEffect(() => {
    let active = true;
    if (!signPagePrivy) { setError('Privy is not configured for this app.'); return () => { active = false; }; }
    const controller = new AbortController();
    signPagePrivy.initialize().then(async () => {
      if (!active) return;
      setReady(true);
      const expectedAccount = localStorage.getItem('trezu_privy_near_signer_account');
      let selectedWallet: Parameters<typeof initSigningPage>[1]['wallet'];
      if (expectedAccount) {
        const { user: privyUser } = await signPagePrivy.user.get();
        const wallets = privyUser.linked_accounts as Array<{ type?: string; chain_type?: string; address?: string; id?: string }>;
        selectedWallet = wallets.find((account) => account.type === 'wallet' && account.chain_type === 'near' && account.address?.toLowerCase() === expectedAccount.toLowerCase()) as typeof selectedWallet;
        if (!selectedWallet) throw new Error('The Privy NEAR wallet selected by Veyra no longer matches this account. Refresh your wallet list and retry.');
      }
      const incomingSession = await initSigningPage(signPagePrivy, { allowedOrigins: [window.location.origin], debug: false, rpcOptions: { url: 'https://rpc.testnet.near.org' }, ...(selectedWallet ? { wallet: selectedWallet } : {}), signal: controller.signal });
      if (active) setSession(incomingSession);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not initialize Privy signing.');
    });
    return () => { active = false; controller.abort(); };
  }, []);
  const approve = async () => {
    if (!session || signing) return;
    setSigning(true); setError('');
    try { await session.sign(); window.close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Privy could not sign this NEAR testnet request.'); setSigning(false); }
  };
  return <main style={{ minHeight: '100vh', background: '#f6f5ef', color: '#182c2b', padding: '40px 20px', fontFamily: 'Inter, Arial, sans-serif' }}><section style={{ width: 'min(100%, 640px)', margin: '30px auto', padding: 32, background: '#fff', border: '1px solid #d9e3dc', borderRadius: 20, boxShadow: '0 16px 50px #173a3020' }}>
    <span style={{ color: '#087c68', fontSize: 12, fontWeight: 800, letterSpacing: 2 }}>VEYRA · PRIVY WALLET</span>
    <h1 style={{ fontSize: 28, margin: '14px 0 8px' }}>{session ? 'Review NEAR testnet transaction' : 'Opening secure approval'}</h1>
    <p style={{ lineHeight: 1.6, color: '#405452' }}>{session ? <>Requested by <b>{session.targetOrigin}</b>. Approve only if these details match the payment you initiated.</> : 'Connecting this request to your signed-in Privy wallet…'}</p>
    {session && <><div style={{ padding: 16, borderRadius: 12, background: '#f5f7f3', border: '1px solid #dfe7df', overflow: 'auto' }}><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.55, margin: 0 }}>{JSON.stringify(session.payload, null, 2)}</pre></div><p style={{ color: '#405452', fontSize: 13 }}>Network: NEAR testnet. The Privy wallet holds the signing key; Veyra does not receive it.</p></>}
    {error && <p role="alert" style={{ color: '#a22c24', fontWeight: 600 }}>{error}</p>}
    <div style={{ display: 'flex', gap: 12, marginTop: 22 }}><button type="button" onClick={() => window.close()} style={{ padding: '12px 18px', borderRadius: 10, border: '1px solid #bacbc3', background: '#fff', color: '#183c35', fontWeight: 700, cursor: 'pointer' }}>Reject / close</button>{session && <button type="button" onClick={() => void approve()} disabled={signing} style={{ padding: '12px 20px', borderRadius: 10, border: 0, background: '#17624e', color: '#fff', fontWeight: 700, cursor: signing ? 'wait' : 'pointer' }}>{signing ? 'Signing…' : 'Approve with Privy'}</button>}</div>
    {!ready && !error && <p role="status" style={{ marginTop: 22 }}>Initializing Privy…</p>}
  </section></main>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WalletIntegrations><AuthProvider>
        <WouterRouter base={basePath}>
          <ScrollToTop />
          <RoutedErrorBoundary>
            <Routes />
          </RoutedErrorBoundary>
        </WouterRouter>
      </AuthProvider></WalletIntegrations>
    </QueryClientProvider>
  );
}

export default App;
