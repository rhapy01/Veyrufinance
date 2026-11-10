import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import {
  ArrowDownRight, ArrowRight, ArrowUpRight, BadgeCheck, BriefcaseBusiness,
  Check, ChevronDown, CircleHelp, Coins, FilePlus2, FileText, Globe2, Layers3,
  LockKeyhole, Menu, MoveUpRight, Plus, Search, ShieldCheck, SlidersHorizontal, Sparkles, Star,
  Users, Wallet, X,
} from 'lucide-react';
import {
  getGetAllocationsQueryKey, getGetDashboardQueryKey, getGetEmployeesQueryKey,
  getGetInvoicesQueryKey, getGetProfileQueryKey, getGetRecordsQueryKey,
  getGetVendorsQueryKey, useCreateEmployee, useCreateInvoice, useCreateVendorApplication,
  useCreateWorkspace, useGetAllocations, useGetDashboard, useGetEmployees, useGetInvoices,
  useGetProfile, useGetRecords, useGetVendors, useUpdateAllocations,
} from '@workspace/api-client-react';
import type { AllocationsInput, EmployeeInput, InvoiceInput, VendorApplicationInput } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#267b5b',
    colorForeground: '#263044',
    colorMutedForeground: '#69717e',
    colorDanger: '#ad4339',
    colorBackground: '#fbfaf6',
    colorInput: '#f7f5ef',
    colorInputForeground: '#263044',
    colorNeutral: '#263044',
    fontFamily: 'DM Sans',
    borderRadius: '0.85rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fbfaf6] rounded-2xl w-[440px] max-w-full overflow-hidden border border-[#e5e0d5]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#263044] font-semibold tracking-tight',
    headerSubtitle: 'text-[#69717e]',
    socialButtonsBlockButtonText: 'text-[#263044] font-medium',
    formFieldLabel: 'text-[#263044] font-medium',
    footerActionLink: 'text-[#267b5b] font-semibold',
    footerActionText: 'text-[#69717e]',
    dividerText: 'text-[#69717e]',
    identityPreviewEditButton: 'text-[#267b5b]',
    formFieldSuccessText: 'text-[#267b5b]',
    alertText: 'text-[#263044]',
    logoBox: 'mb-2',
    logoImage: 'max-h-9',
    socialButtonsBlockButton: 'border-[#e5e0d5] bg-[#fffefa] hover:bg-[#f2efe7]',
    formButtonPrimary: 'bg-[#267b5b] hover:bg-[#1e694d] text-white shadow-none',
    formFieldInput: 'border-[#d8d2c6] bg-[#f7f5ef] text-[#263044]',
    footerAction: 'text-[#69717e]',
    dividerLine: 'bg-[#e5e0d5]',
    alert: 'border-[#e5e0d5] bg-[#f7f5ef]',
    otpCodeFieldInput: 'border-[#d8d2c6] bg-[#f7f5ef]',
    formFieldRow: 'gap-1.5',
    main: 'gap-5',
  },
};

function Brand({ light = false }: { light?: boolean }) {
  return <Link href="/" className={`brand ${light ? 'brand-light' : ''}`} data-testid="link-brand">
    <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
    <span>trezu</span>
  </Link>;
}

function HomePage() {
  const { isSignedIn } = useUser();
  if (isSignedIn) return <Redirect to="/app" />;
  return <main className="marketing">
    <div className="announce"><span className="announce-dot" /> A calmer way to work across borders <ArrowRight size={14} /></div>
    <header className="marketing-nav wrap">
      <Brand />
      <nav className="marketing-links" aria-label="Main navigation">
        <a href="#platform">Platform</a><a href="#principles">Why Trezu</a><a href="#trust">Trust</a>
      </nav>
      <div className="nav-actions"><Link href="/sign-in" className="text-link">Sign in</Link><Link href="/sign-up" className="button button-dark button-small">Open your workspace <ArrowRight size={15} /></Link></div>
    </header>
    <section className="hero wrap">
      <div className="hero-copy">
        <div className="eyebrow"><span className="eyebrow-line" /> FINANCE, IN ONE PLACE</div>
        <h1>Your work is global.<br /><em>Your money should be, too.</em></h1>
        <p className="hero-sub">The financial workspace for independent people and ambitious teams. Keep invoices, people, and money preferences in one considered place.</p>
        <div className="hero-ctas"><Link href="/sign-up" className="button button-green">Create your workspace <ArrowRight size={16} /></Link><a className="button button-outline" href="#platform">Explore Trezu <ArrowDownRight size={16} /></a></div>
        <div className="hero-proof"><span className="proof-icon"><ShieldCheck size={17} /></span><span>Clear records. No imagined balances.<br /><b>Built for financial clarity.</b></span></div>
      </div>
      <div className="hero-visual" aria-label="Trezu workspace preview">
        <div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" />
        <div className="visual-globe"><div className="globe-grid" /><div className="globe-center"><span className="globe-logo"><span /><span /><span /></span></div><span className="globe-point point-a" /><span className="globe-point point-b" /><span className="globe-point point-c" /></div>
        <div className="float-card card-workspace"><div className="float-label"><span className="tiny-icon"><Layers3 size={14} /></span> WORKSPACE</div><strong>Everything, in rhythm.</strong><span className="float-small">Invoices · People · Records</span></div>
        <div className="float-card card-record"><span className="record-symbol"><FileText size={16} /></span><div><strong>Invoice draft</strong><span className="float-small">Saved just now</span></div><Check size={16} className="record-check" /></div>
        <div className="visual-caption"><span className="caption-line" /> BUILT AROUND YOUR WORK</div>
      </div>
      <div className="hero-bottom-line"><span>FINANCIAL OPERATING SYSTEM</span><span className="bottom-line-track" /><span>01 / 04</span></div>
    </section>
     <section className="trust-strip" id="trust"><div className="wrap trust-inner"><span className="trust-lead">A little less financial noise.</span><span className="trust-item"><LockKeyhole size={15} /> Private by design</span><span className="trust-item"><BadgeCheck size={16} /> Vendor listings by approval</span><span className="trust-item"><Globe2 size={16} /> Made for cross-border work</span></div></section>
    <section className="platform-section wrap" id="platform">
      <div className="section-intro"><div className="eyebrow"><span className="eyebrow-line" /> THE WHOLE PICTURE</div><h2>One workspace.<br /><em>Fewer loose ends.</em></h2><p>Trezu brings the working parts of your finances together without pretending to do what it cannot.</p></div>
      <div className="platform-grid">
        <article className="platform-feature feature-large"><div className="feature-top"><span className="feature-num">01 / DOCUMENTS</span><FileText size={20} /></div><div className="paper-stack"><div className="paper paper-back" /><div className="paper paper-front"><span className="paper-dot" /><span className="paper-line wide" /><span className="paper-line" /><span className="paper-total">USD 2,840.00</span><span className="paper-foot">DRAFT · NOT SENT</span></div></div><h3>Invoices, ready when you are.</h3><p>Save clean invoice drafts with the details you need. Sending and payment collection are not available in Trezu yet.</p><Link href="/sign-up" className="feature-link">See the workspace <ArrowRight size={15} /></Link></article>
        <article className="platform-feature feature-people"><div className="feature-top"><span className="feature-num">02 / PEOPLE</span><Users size={19} /></div><div className="people-graphic"><span className="person-chip chip-one">AM</span><span className="person-chip chip-two">JK</span><span className="person-chip chip-three">SN</span><span className="people-connect" /><span className="people-caption">Your people, your preferences</span></div><h3>Keep your team in view.</h3><p>Store compensation and wallet preferences without initiating payroll or moving funds.</p><Link href="/sign-up" className="feature-link">Meet payroll records <ArrowRight size={15} /></Link></article>
         <article className="platform-feature feature-allocations"><div className="feature-top"><span className="feature-num">03 / PREFERENCES</span><SlidersHorizontal size={19} /></div><div className="allocation-mini"><span className="allocation-arc" /><div><strong>50 / 30 / 20</strong><small>Example allocation</small></div><span className="allocation-spark"><Sparkles size={17} /></span></div><h3>Plan with intention.</h3><p>Set tax, savings, and spending preferences. Your choices are saved as preferences only, not transfers.</p><Link href="/sign-up" className="feature-link">Set your preferences <ArrowRight size={15} /></Link></article>
      </div>
    </section>
    <section className="statement-band" id="principles"><div className="wrap statement-inner"><div className="statement-index">OUR POINT OF VIEW <span>02 / 04</span></div><h2>Trust is not a badge.<br />It is <em>knowing what happened.</em></h2><p>Trezu distinguishes what is saved from what is settled. You will always know when something is a draft, a preference, or an actual record.</p><div className="statement-seal"><span>BUILT FOR<br />CLARITY</span><ShieldCheck size={21} /></div></div></section>
      <section className="vendors-section wrap"><div className="vendor-copy"><div className="eyebrow"><span className="eyebrow-line" /> LOCAL, REVIEWED, VISIBLE</div><h2>Find the right<br /><em>people to work with.</em></h2><p>Explore approved vendor listings, including businesses serving Uganda. Compare listed payment methods and indicative information, then decide directly.</p><Link href="/sign-up" className="button button-dark">Explore the exchange <ArrowRight size={16} /></Link><small>Listings are informational. Trezu does not initiate or guarantee trades.</small></div><div className="vendor-preview"><div className="vp-head"><div><span className="vp-kicker">TREZU EXCHANGE</span><strong>Manual vendor review</strong></div><span className="vp-filter"><SlidersHorizontal size={14} /> Uganda</span></div><div className="vp-list vp-list-empty"><span className="vp-empty-icon"><ShieldCheck size={20} /></span><b>Listings follow review</b><span>Vendor profiles appear only after manual approval.</span><div className="vp-method-chips"><i>MTN Mobile Money</i><i>Airtel Money</i><i>Bank transfer</i></div></div><div className="vp-foot"><span><span className="live-dot" /> Curated marketplace</span><span>UGX support</span></div></div></section>
    <section className="closing-section"><div className="wrap closing-inner"><span className="closing-star"><Sparkles size={18} /></span><div><div className="eyebrow">MAKE SPACE FOR YOUR WORK</div><h2>Keep the money side<br /><em>in good order.</em></h2></div><Link href="/sign-up" className="button button-cream">Start with Trezu <ArrowRight size={16} /></Link><div className="closing-note">No transfers. No payment claims.<br />Just a clearer place to begin.</div></div></section>
     <footer className="marketing-footer wrap"><Brand /><span>Financial clarity for work without borders.</span><div><a href="#trust">Trust & clarity</a><Link href="/sign-in">Sign in</Link></div><small>© 2026 Trezu Financial Workspace</small></footer>
  </main>;
}

function SignInPage() {
  return <div className="auth-page"><div className="auth-side"><Brand light /><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR WORK, IN RHYTHM</div><h1>Welcome back<br /><em>to your workspace.</em></h1><p>Pick up where you left off. Your financial records are right where you saved them.</p></div><span className="auth-note">A financial operating system for people who work everywhere.</span></div><div className="auth-form-side"><Link href="/" className="auth-back"><ArrowDownRight size={15} /> Back to Trezu</Link><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div></div>;
}
function SignUpPage() {
  return <div className="auth-page"><div className="auth-side"><Brand light /><div><div className="eyebrow"><span className="eyebrow-line" /> A CLEARER START</div><h1>Make room for<br /><em>your next chapter.</em></h1><p>Create a workspace for your independent work or the team you are building.</p></div><span className="auth-note">Your money deserves a little more order.</span></div><div className="auth-form-side"><Link href="/" className="auth-back"><ArrowDownRight size={15} /> Back to Trezu</Link><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div></div>;
}

const navItems = [
  { href: '/app', label: 'Overview', icon: Layers3, section: 'WORKSPACE' },
  { href: '/app/invoices', label: 'Invoices', icon: FileText, section: 'WORKSPACE' },
  { href: '/app/payroll', label: 'Payroll records', icon: Users, section: 'WORKSPACE' },
  { href: '/app/treasury', label: 'Treasury', icon: Coins, section: 'MONEY PREFERENCES' },
  { href: '/app/exchange', label: 'Exchange', icon: Globe2, section: 'NETWORK' },
  { href: '/app/records', label: 'All records', icon: BriefcaseBusiness, section: 'NETWORK' },
];

function AppFrame({ children, title, eyebrow, action }: { children: ReactNode; title: string; eyebrow: string; action?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { signOut } = useClerk();
  const { user } = useUser();
  const [location] = useLocation();
  const initials = `${user?.firstName?.[0] || ''}${user?.lastName?.[0] || user?.primaryEmailAddress?.emailAddress?.[0] || 'T'}`.toUpperCase();
  return <div className="app-shell">
    <aside className={`app-sidebar ${open ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand"><Brand light /><button className="mobile-close icon-button" onClick={() => setOpen(false)} aria-label="Close menu"><X size={18} /></button></div>
      <div className="workspace-switch"><span className="workspace-avatar">T</span><span><b>Trezu workspace</b><small>Financial home</small></span><ChevronDown size={15} /></div>
      <nav className="side-nav" aria-label="Workspace navigation">
        {['WORKSPACE', 'MONEY PREFERENCES', 'NETWORK'].map((section) => <div className="nav-section" key={section}><span className="nav-section-title">{section}</span>{navItems.filter((item) => item.section === section).map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setOpen(false)} className={`side-link ${location === href ? 'side-link-active' : ''}`} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={17} strokeWidth={1.8} /><span>{label}</span>{href === '/app/records' && <span className="side-link-arrow"><ArrowUpRight size={13} /></span>}</Link>)}</div>)}
      </nav>
      <div className="sidebar-bottom"><div className="side-help"><span className="help-icon"><CircleHelp size={17} /></span><div><b>Need a hand?</b><small>Clear answers, always.</small></div><ArrowUpRight size={14} /></div><button type="button" className="user-menu" onClick={() => signOut({ redirectUrl: basePath || '/' })} data-testid="button-sign-out"><span className="user-initial">{initials}</span><span className="user-details"><b>{user?.firstName || 'Your account'}</b><small>{user?.primaryEmailAddress?.emailAddress || 'Signed in'}</small></span><ArrowDownRight size={14} /></button></div>
    </aside>
    {open && <button className="sidebar-scrim" onClick={() => setOpen(false)} aria-label="Close navigation" />}
    <section className="app-main">
      <header className="app-topbar"><button className="mobile-menu icon-button" onClick={() => setOpen(true)} aria-label="Open menu"><Menu size={20} /></button><div className="topbar-breadcrumb"><span>Workspace</span><span className="breadcrumb-slash">/</span><b>{title}</b></div><div className="topbar-right"><span className="secure-label"><LockKeyhole size={13} /> Private workspace</span><span className="topbar-user">{initials}</span></div></header>
      <main className="page-content"><div className="page-heading"><div><span className="page-eyebrow">{eyebrow}</span><h1>{title}</h1></div>{action}</div>{children}<footer className="app-footer"><span>Trezu keeps a clear record of what is saved.</span><span>Need help? <b>We are here.</b></span></footer></main>
    </section>
  </div>;
}

function Protected({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  if (!isLoaded) return <div className="auth-loading"><div className="loading-mark"><span /><span /><span /></div><span>Preparing your workspace</span></div>;
  if (!isSignedIn) return <Redirect to="/" />;
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
  return <AppFrame title="Set up your workspace" eyebrow="A GOOD PLACE TO BEGIN"><div className="setup-card"><div className="setup-mark"><Layers3 size={23} /></div><span className="page-eyebrow">YOUR FINANCIAL HOME</span><h2>Give your workspace a name.</h2><p>This is where your invoice drafts, payroll records, preferences, and financial records come together.</p><form onSubmit={submit} className="form-stack"><label>Workspace name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ada Studio" data-testid="input-workspace-name" /></label><label>Workspace type<select value={type} onChange={(e) => setType(e.target.value as 'freelancer' | 'business')} data-testid="select-workspace-type"><option value="freelancer">Freelancer</option><option value="business">Business / team</option></select></label>{create.isError && <p className="form-error">We could not create your workspace. Please try again.</p>}<button className="button button-green" disabled={create.isPending}>{create.isPending ? 'Creating workspace…' : 'Create workspace'} <ArrowRight size={15} /></button></form></div></AppFrame>;
}

function DashboardPage() {
  const dashboard = useGetDashboard({ query: { queryKey: getGetDashboardQueryKey() } });
  if (dashboard.isLoading) return <AppFrame title="Overview" eyebrow="YOUR FINANCIAL HOME"><StatePanel kind="loading" title="Gathering your workspace" text="Your overview is getting ready." /><div className="skeleton-dashboard"><i /><i /><i /></div></AppFrame>;
  if (dashboard.isError || !dashboard.data) return <AppFrame title="Overview" eyebrow="YOUR FINANCIAL HOME"><StatePanel kind="error" title="Your overview is taking a moment" text="We could not load your workspace data." retry={() => dashboard.refetch()} /></AppFrame>;
  const data = dashboard.data;
  return <AppFrame title="Overview" eyebrow={`GOOD TO SEE YOU · ${data.workspaceName.toUpperCase()}`}>
    <div className="overview-banner"><div className="overview-banner-copy"><span className="banner-kicker"><span className="banner-dot" /> YOUR WORKSPACE IS READY</span><h2>Good work deserves<br />a <em>clear home.</em></h2><p>Keep the moving parts of your work close at hand. Nothing moves without you.</p><Link href="/app/records" className="banner-link">See your financial records <ArrowRight size={15} /></Link></div><div className="overview-illustration"><div className="ring ring-outer" /><div className="ring ring-middle" /><div className="ring ring-inner" /><div className="ring-center"><span className="brand-mark"><span /><span /><span /></span></div><span className="ring-node node-left"><FileText size={15} /></span><span className="ring-node node-right"><Users size={15} /></span><span className="ring-node node-bottom"><Coins size={15} /></span></div><div className="banner-index">TREZU / 001</div></div>
    <div className="overview-stat-grid">
      <StatCard label="Invoice drafts" value={String(data.invoiceCount)} note="Saved for later" icon={<FileText size={17} />} href="/app/invoices" color="green" />
      <StatCard label="Payroll records" value={String(data.employeeCount)} note="Compensation preferences" icon={<Users size={17} />} href="/app/payroll" color="gold" />
      <StatCard label="Vendor applications" value={String(data.pendingVendorApplications)} note="Awaiting review" icon={<Globe2 size={17} />} href="/app/exchange" color="blue" />
      <div className="stat-card balance-card"><div className="stat-top"><span className="stat-icon icon-soft-green"><Wallet size={17} /></span><span className="stat-note">WALLET STATUS</span></div><div className="balance-value">Not connected</div><div className="stat-caption"><span className="status-pill status-muted"><span /> No wallet linked</span></div></div>
    </div>
    <div className="overview-lower"><section className="quick-panel"><div className="panel-heading"><div><span className="page-eyebrow">A FEW GOOD NEXT STEPS</span><h2>Pick up where you need.</h2></div><span className="panel-ornament"><MoveUpRight size={15} /></span></div><div className="quick-list"><QuickLink href="/app/invoices" num="01" icon={<FilePlus2 size={17} />} title="Save an invoice draft" text="Keep client and amount details together." /><QuickLink href="/app/payroll" num="02" icon={<Users size={17} />} title="Add a payroll record" text="Store compensation and wallet preferences." /><QuickLink href="/app/treasury" num="03" icon={<SlidersHorizontal size={17} />} title="Set allocation preferences" text="Plan a split. Preferences only, no transfers." /></div></section><section className="integrity-panel"><div className="integrity-top"><span className="integrity-icon"><ShieldCheck size={18} /></span><span>THE TREZU PROMISE</span></div><h3>Clear about what is real.</h3><p>Your wallet is not connected and there is no confirmed balance to show. We will never fill that gap with an estimate.</p><div className="integrity-divider" /><div className="integrity-status"><span className="integrity-pulse" /> Workspace records are private</div></section></div>
  </AppFrame>;
}

function StatCard({ label, value, note, icon, href, color }: { label: string; value: string; note: string; icon: ReactNode; href: string; color: string }) {
  return <Link href={href} className="stat-card" data-testid={`card-stat-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="stat-top"><span className={`stat-icon icon-soft-${color}`}>{icon}</span><ArrowUpRight size={15} className="stat-arrow" /></div><div className="stat-value">{value}</div><div className="stat-label">{label}</div><div className="stat-caption">{note}</div></Link>;
}
function QuickLink({ href, num, icon, title, text }: { href: string; num: string; icon: ReactNode; title: string; text: string }) {
  return <Link href={href} className="quick-row" data-testid={`link-next-step-${num}`}><span className="quick-num">{num}</span><span className="quick-icon">{icon}</span><span className="quick-text"><b>{title}</b><small>{text}</small></span><ArrowRight size={16} className="quick-arrow" /></Link>;
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const close = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', close); document.body.style.overflow = 'hidden'; return () => { window.removeEventListener('keydown', close); document.body.style.overflow = ''; }; }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-top"><div><span className="page-eyebrow">TREZU WORKSPACE</span><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</section></div>;
}

function InvoicesPage() {
  const list = useGetInvoices({ query: { queryKey: getGetInvoicesQueryKey() } });
  const create = useCreateInvoice();
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const data: InvoiceInput = { clientName: String(form.get('clientName')).trim(), clientEmail: String(form.get('clientEmail') || '').trim() || null, description: String(form.get('description')).trim(), amount: String(form.get('amount')).trim(), currency: String(form.get('currency')).toUpperCase() };
    create.mutate({ data }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetInvoicesQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getGetRecordsQueryKey() }); setModal(false); setNotice('Draft saved. It has not been sent to your client.'); }, onError: () => setNotice('The draft could not be saved. Check the details and try again.') });
  };
  return <AppFrame title="Invoices" eyebrow="DOCUMENTS, WITHOUT THE PAPER TRAIL" action={<button className="button button-green" onClick={() => { setNotice(''); setModal(true); }} data-testid="button-new-invoice"><Plus size={16} /> New draft</button>}>
    <div className="page-intro"><p>Keep client and billing details together as a draft. Trezu does not send invoices or collect payments.</p><span className="intro-stamp"><FileText size={17} /> SAVED DRAFTS</span></div>
    {notice && <div className={`inline-notice ${notice.startsWith('Draft') ? 'notice-success' : 'notice-error'}`}><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15} /></button></div>}
     {list.isLoading ? <StatePanel kind="loading" title="Loading invoice drafts" text="Your saved drafts will be here shortly." /> : list.isError ? <StatePanel kind="error" title="Drafts did not load" text="Your invoice records are safe. Try loading them again." retry={() => list.refetch()} /> : !list.data?.length ? <EmptyState icon={<FileText size={22} />} title="No drafts, no loose ends." text="When you are ready, save your first invoice draft here. It will stay a draft until you take it elsewhere." action={<button className="button button-green" onClick={() => setModal(true)}><Plus size={16} /> Create invoice draft</button>} /> : <div className="table-wrap"><table><thead><tr><th>INVOICE</th><th>CLIENT</th><th>DESCRIPTION</th><th>AMOUNT</th><th>STATUS</th><th>CREATED</th></tr></thead><tbody>{list.data.map((item) => <tr key={item.id} data-testid={`row-invoice-${item.id}`}><td><b className="record-number">{item.invoiceNumber}</b></td><td><span className="cell-primary">{item.clientName}</span><small className="cell-secondary">{item.clientEmail || 'No email saved'}</small></td><td className="description-cell">{item.description}</td><td className="amount-cell">{formatDecimalAmount(item.currency, item.amount)}</td><td><span className="status-pill status-draft"><span /> Draft</span></td><td className="date-cell">{formatDate(item.createdAt)}</td></tr>)}</tbody></table></div>}
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>A draft is only a draft.</b> No email is sent, no payment is requested, and no transaction is created by saving here.</span></div>
    {modal && <Modal title="New invoice draft" subtitle="Save the details you want to keep on hand." onClose={() => setModal(false)}><form className="form-stack" onSubmit={submit}><label>Client name<input name="clientName" required maxLength={160} placeholder="Client or company" data-testid="input-invoice-client" /></label><label>Client email <span className="optional-label">OPTIONAL</span><input type="email" name="clientEmail" placeholder="name@company.com" data-testid="input-invoice-email" /></label><label>Description<textarea name="description" required maxLength={2000} rows={3} placeholder="What was the work?" data-testid="input-invoice-description" /></label><div className="form-pair"><label>Amount<input type="number" name="amount" required min="0" step="0.000001" placeholder="0.00" data-testid="input-invoice-amount" /></label><label>Currency<input name="currency" required minLength={3} maxLength={3} defaultValue="USD" data-testid="input-invoice-currency" /></label></div>{create.isError && <p className="form-error">Could not save this draft. Please try again.</p>}<div className="form-actions"><button type="button" className="button button-outline" onClick={() => setModal(false)}>Cancel</button><button className="button button-green" disabled={create.isPending}>{create.isPending ? 'Saving draft…' : 'Save draft'} <ArrowRight size={15} /></button></div><p className="form-footnote">Saving does not send this invoice or collect payment.</p></form></Modal>}
  </AppFrame>;
}

function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><span className="page-eyebrow">A CLEAN SLATE</span><h2>{title}</h2><p>{text}</p>{action}</div>;
}
function formatDate(date: string) { return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function formatDecimalAmount(currency: string, amount: string) {
  const [whole, fraction] = amount.split('.');
  const groupedWhole = BigInt(whole || '0').toLocaleString();
  const visibleFraction = fraction ? fraction.padEnd(2, '0') : '00';
  return `${currency} ${groupedWhole}.${visibleFraction}`;
}

function PayrollPage() {
  const list = useGetEmployees({ query: { queryKey: getGetEmployeesQueryKey() } });
  const create = useCreateEmployee();
  const qc = useQueryClient();
  const [modal, setModal] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const f = new FormData(event.currentTarget);
    const data: EmployeeInput = { name: String(f.get('name')).trim(), email: String(f.get('email')).trim(), compensationAmount: String(f.get('amount')).trim(), compensationCurrency: String(f.get('currency')).toUpperCase(), payFrequency: String(f.get('frequency')) as EmployeeInput['payFrequency'], preferredStablecoin: String(f.get('stablecoin')) as EmployeeInput['preferredStablecoin'], preferredNetwork: String(f.get('network')).trim(), walletAddress: String(f.get('walletAddress') || '').trim() || null };
    create.mutate({ data }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetEmployeesQueryKey() }); qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getGetRecordsQueryKey() }); setModal(false); setNotice('Payroll record saved. No payment was made or scheduled.'); }, onError: () => setNotice('The record could not be saved. Please try again.') });
  };
  return <AppFrame title="Payroll records" eyebrow="PEOPLE AND COMPENSATION" action={<button className="button button-green" onClick={() => { setNotice(''); setModal(true); }} data-testid="button-add-employee"><Plus size={16} /> Add record</button>}>
    <div className="page-intro"><p>Save employee compensation and wallet preferences in one place. These are records only, not payroll instructions.</p><span className="intro-stamp"><Users size={17} /> TEAM RECORDS</span></div>
    {notice && <div className="inline-notice notice-success"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    {list.isLoading ? <StatePanel kind="loading" title="Loading payroll records" text="Your saved employee records will appear here." /> : list.isError ? <StatePanel kind="error" title="Records did not load" text="We could not reach your payroll records." retry={() => list.refetch()} /> : !list.data?.length ? <EmptyState icon={<Users size={22} />} title="Your team starts here." text="Keep compensation and wallet preferences organized. Adding a record will not trigger or schedule a payment." action={<button className="button button-green" onClick={() => setModal(true)}><Plus size={16} /> Add payroll record</button>} /> : <div className="table-wrap"><table><thead><tr><th>TEAM MEMBER</th><th>COMPENSATION</th><th>FREQUENCY</th><th>WALLET PREFERENCE</th><th>ADDED</th></tr></thead><tbody>{list.data.map((person) => <tr key={person.id} data-testid={`row-employee-${person.id}`}><td><div className="person-cell"><span className="person-initials">{person.name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()}</span><span><b className="cell-primary">{person.name}</b><small className="cell-secondary">{person.email}</small></span></div></td><td className="amount-cell">{formatDecimalAmount(person.compensationCurrency, person.compensationAmount)}</td><td><span className="frequency-label">{person.payFrequency}</span></td><td><div className="wallet-cell"><b>{person.preferredStablecoin}</b><small>{person.preferredNetwork}{person.walletAddress ? ` · ${shorten(person.walletAddress)}` : ' · No address saved'}</small></div></td><td className="date-cell">{formatDate(person.createdAt)}</td></tr>)}</tbody></table></div>}
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>Record keeping, not payroll processing.</b> Trezu will not send employee emails, initiate transfers, or claim that compensation has been paid.</span></div>
    {modal && <Modal title="Add a payroll record" subtitle="Store compensation and wallet preferences for your team." onClose={() => setModal(false)}><form className="form-stack" onSubmit={submit}><div className="form-pair"><label>Full name<input name="name" required maxLength={160} placeholder="Name" data-testid="input-employee-name" /></label><label>Email<input type="email" name="email" required placeholder="name@email.com" data-testid="input-employee-email" /></label></div><div className="form-pair amount-pair"><label>Compensation amount<input type="number" name="amount" required min="0" step="0.000001" placeholder="0.00" data-testid="input-employee-amount" /></label><label>Currency<input name="currency" required minLength={3} maxLength={3} defaultValue="USD" data-testid="input-employee-currency" /></label></div><div className="form-pair"><label>Pay frequency<select name="frequency" defaultValue="monthly" data-testid="select-pay-frequency"><option value="weekly">Weekly</option><option value="biweekly">Biweekly</option><option value="monthly">Monthly</option></select></label><label>Preferred stablecoin<select name="stablecoin" defaultValue="USDC" data-testid="select-stablecoin"><option value="USDC">USDC</option><option value="USDT">USDT</option></select></label></div><label>Preferred network<input name="network" required maxLength={80} placeholder="e.g. Polygon" data-testid="input-preferred-network" /></label><label>Wallet address <span className="optional-label">OPTIONAL</span><input name="walletAddress" placeholder="Address preference only" data-testid="input-wallet-address" /></label>{create.isError && <p className="form-error">Could not save this record. Please try again.</p>}<div className="form-actions"><button type="button" className="button button-outline" onClick={() => setModal(false)}>Cancel</button><button className="button button-green" disabled={create.isPending}>{create.isPending ? 'Saving record…' : 'Save record'} <ArrowRight size={15} /></button></div><p className="form-footnote">Saving this record does not transfer funds or send an email.</p></form></Modal>}
  </AppFrame>;
}
function shorten(text: string) { return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-5)}` : text; }

function TreasuryPage() {
  const query = useGetAllocations({ query: { queryKey: getGetAllocationsQueryKey() } });
  const update = useUpdateAllocations();
  const qc = useQueryClient();
  const [values, setValues] = useState<AllocationsInput | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { if (query.data && !values) setValues({ taxPercent: query.data.taxPercent, savingsPercent: query.data.savingsPercent, spendingPercent: query.data.spendingPercent, automationEnabled: query.data.automationEnabled }); }, [query.data, values]);
  const sum = values ? values.taxPercent + values.savingsPercent + values.spendingPercent : 0;
  const change = (key: 'taxPercent' | 'savingsPercent' | 'spendingPercent', value: string) => setValues((old) => old ? { ...old, [key]: Math.max(0, Math.min(100, Number(value) || 0)) } : old);
  const save = () => { if (!values || sum !== 100) return; update.mutate({ data: values }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetAllocationsQueryKey() }); setMessage('Preferences saved. No funds were moved.'); }, onError: () => setMessage('We could not save those preferences. Try again.') }); };
  return <AppFrame title="Treasury" eyebrow="YOUR ALLOCATION PREFERENCES">
    <div className="page-intro"><p>Choose how you would like to think about your money. These percentages are preferences only.</p><span className="intro-stamp"><Coins size={17} /> PLAN, NOT TRANSFER</span></div>
    <div className="treasury-notice"><span className="notice-shield"><ShieldCheck size={18} /></span><div><b>These preferences do not move funds.</b><p>Trezu does not automate transfers, move money, or connect to a bank or wallet here. Automation is not active.</p></div><span className="notice-tag">PREFERENCES ONLY</span></div>
    {query.isLoading ? <StatePanel kind="loading" title="Loading your preferences" text="Your saved allocation preferences will appear shortly." /> : query.isError ? <StatePanel kind="error" title="Preferences did not load" text="Try again to view your saved allocation preferences." retry={() => query.refetch()} /> : values && <div className="treasury-layout"><section className="allocation-card"><div className="allocation-heading"><div><span className="page-eyebrow">ALLOCATION SPLIT</span><h2>Make a plan that fits.</h2></div><span className="allocation-total">{sum}<small> / 100</small></span></div><p className="allocation-description">Adjust each category. Together, the preference must equal 100%.</p>{(['taxPercent', 'savingsPercent', 'spendingPercent'] as const).map((key, i) => { const labels = ['Tax reserve', 'Savings', 'Spending']; const hints = ['Set aside for obligations', 'Build a buffer over time', 'Available for day-to-day']; return <div className="allocation-control" key={key}><div className="allocation-control-head"><span className={`allocation-dot allocation-dot-${i}`} /><div><b>{labels[i]}</b><small>{hints[i]}</small></div><div className="percent-input"><input aria-label={`${labels[i]} percent`} type="number" min="0" max="100" value={values[key]} onChange={(e) => change(key, e.target.value)} data-testid={`input-${key}`} /><span>%</span></div></div><input className={`allocation-range range-${i}`} type="range" min="0" max="100" value={values[key]} onChange={(e) => change(key, e.target.value)} aria-label={`${labels[i]} slider`} /></div>})}
      <div className={`sum-message ${sum === 100 ? 'sum-valid' : 'sum-invalid'}`}><span>{sum === 100 ? <Check size={15} /> : <CircleHelp size={15} />}</span>{sum === 100 ? 'Your allocation preferences add up to 100%.' : `Your preferences currently total ${sum}%. Adjust them to equal 100%.`}</div>
       <div className="automation-setting"><div><b>Automated transfers</b><small>Unavailable until a verified movement provider is connected.</small></div><label className="switch"><input type="checkbox" checked={false} disabled aria-label="Automated transfers unavailable" data-testid="toggle-automation-preference" /><span /></label></div>
      {message && <div className={`inline-notice ${message.startsWith('Preferences') ? 'notice-success' : 'notice-error'}`}>{message}</div>}
      <button className="button button-green save-allocation" onClick={save} disabled={sum !== 100 || update.isPending} data-testid="button-save-allocations">{update.isPending ? 'Saving preferences…' : 'Save preferences'} <ArrowRight size={15} /></button>
      {query.data?.updatedAt && <div className="updated-at">Last updated {formatDate(query.data.updatedAt)}</div>}
     </section><aside className="allocation-preview"><span className="page-eyebrow">YOUR CURRENT PLAN</span><div className="allocation-chart"><div className="chart-value">{sum === 100 ? '100%' : `${sum}%`}<small>allocated</small></div><div className="chart-ring" style={{ background: `conic-gradient(#397f61 0 ${values.taxPercent}%, #d9b45d ${values.taxPercent}% ${values.taxPercent + values.savingsPercent}%, #597a9a ${values.taxPercent + values.savingsPercent}% 100%)` }} /></div><div className="preview-legend"><span><i className="legend-0" /> Tax reserve <b>{values.taxPercent}%</b></span><span><i className="legend-1" /> Savings <b>{values.savingsPercent}%</b></span><span><i className="legend-2" /> Spending <b>{values.spendingPercent}%</b></span></div><div className="preview-foot">{query.data?.updatedAt ? <><LockKeyhole size={14} /> Saved preferences, funds not moved</> : <><Sparkles size={14} /> Suggested starting point, not saved yet</>}</div></aside></div>}
  </AppFrame>;
}

function ExchangePage() {
  const [country, setCountry] = useState('');
  const [currency, setCurrency] = useState('');
  const [showApplication, setShowApplication] = useState(false);
  const [message, setMessage] = useState('');
  const [methodError, setMethodError] = useState('');
  const params = useMemo(() => ({ ...(country ? { country } : {}), ...(currency ? { currency } : {}) }), [country, currency]);
  const vendors = useGetVendors(params, { query: { queryKey: getGetVendorsQueryKey(params) } });
  const apply = useCreateVendorApplication();
  const qc = useQueryClient();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const f = new FormData(event.currentTarget);
    const methods = f.getAll('methods').map(String) as VendorApplicationInput['paymentMethods'];
    if (!methods.length) { setMethodError('Choose at least one payment method.'); return; }
    const data: VendorApplicationInput = { businessName: String(f.get('businessName')).trim(), country: String(f.get('country')).toUpperCase(), currency: String(f.get('currency')).toUpperCase(), paymentMethods: methods };
    apply.mutate({ data }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() }); qc.invalidateQueries({ queryKey: getGetRecordsQueryKey() }); setShowApplication(false); setMessage('Application submitted. It is pending review and is not an approved listing.'); }, onError: () => setMessage('Your application could not be submitted. Please try again.') });
  };
  return <AppFrame title="Exchange" eyebrow="A NETWORK OF APPROVED VENDORS" action={<button className="button button-green" onClick={() => { setMessage(''); setShowApplication(true); }} data-testid="button-apply-vendor"><Plus size={16} /> Apply as vendor</button>}>
    <div className="page-intro"><p>Browse approved vendor listings. Compare their published details and make your own decisions outside Trezu.</p><span className="intro-stamp"><BadgeCheck size={17} /> APPROVED LISTINGS</span></div>
    {message && <div className={`inline-notice ${message.startsWith('Application submitted') ? 'notice-success' : 'notice-error'}`}><span>{message}</span><button onClick={() => setMessage('')} aria-label="Dismiss message"><X size={15} /></button></div>}
    <div className="exchange-toolbar"><div className="exchange-search"><Search size={16} /><span>Filter approved vendors</span></div><div className="filter-controls"><label>Country<select value={country} onChange={(e) => setCountry(e.target.value)} data-testid="filter-vendor-country"><option value="">All countries</option><option value="UG">Uganda</option><option value="KE">Kenya</option><option value="NG">Nigeria</option><option value="GH">Ghana</option></select></label><label>Currency<select value={currency} onChange={(e) => setCurrency(e.target.value)} data-testid="filter-vendor-currency"><option value="">All currencies</option><option value="UGX">UGX</option><option value="KES">KES</option><option value="USD">USD</option><option value="NGN">NGN</option></select></label></div></div>
    <div className="uganda-callout"><div className="uganda-mark">UG</div><div><b>Explore Uganda</b><span>Filter approved listings by country or currency to find the details you need.</span></div><button onClick={() => { setCountry('UG'); setCurrency(''); }} className="text-button">Show Uganda listings <ArrowRight size={14} /></button></div>
    {vendors.isLoading ? <StatePanel kind="loading" title="Finding approved vendors" text="Listings are loading." /> : vendors.isError ? <StatePanel kind="error" title="Vendor listings did not load" text="Check your connection and try again." retry={() => vendors.refetch()} /> : !vendors.data?.length ? <EmptyState icon={<Globe2 size={22} />} title="No listings match those filters." text="Try broadening your country or currency selection. New approved listings will appear here." action={<button className="button button-outline" onClick={() => { setCountry(''); setCurrency(''); }}>Clear filters</button>} /> : <div className="vendor-grid">{vendors.data.map((vendor) => <article className="vendor-card" key={vendor.id} data-testid={`card-vendor-${vendor.id}`}><div className="vendor-card-top"><span className="vendor-avatar">{vendor.businessName.slice(0, 1).toUpperCase()}</span><span className="vendor-approved"><BadgeCheck size={14} /> APPROVED</span></div><h3>{vendor.businessName}</h3><div className="vendor-country"><Globe2 size={14} /> {countryName(vendor.country)} <span>·</span> {vendor.currency}</div><div className="vendor-data"><span>INDICATIVE RATE</span><b>{vendor.indicativeRate || 'Not listed'}</b></div><div className="vendor-methods">{vendor.paymentMethods.map((m) => <span key={m}>{m}</span>)}</div><div className="vendor-footer"><span><Star size={10} className="rating-star" fill="currentColor" /> {vendor.rating ?? 'No rating'} <small>· {vendor.completedTrades} listed trades</small></span></div></article>)}</div>}
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>Approved means listed, not guaranteed.</b> Rates and payment methods are informational. Trezu does not execute trades, settle payments, or guarantee vendor outcomes.</span></div>
    {showApplication && <Modal title="Apply as a vendor" subtitle="Submit your business details for review." onClose={() => setShowApplication(false)}><form className="form-stack" onSubmit={submit}><label>Business name<input required maxLength={160} name="businessName" placeholder="Your registered business" data-testid="input-vendor-name" /></label><div className="form-pair"><label>Country code<input required minLength={2} maxLength={2} name="country" defaultValue="UG" placeholder="UG" data-testid="input-vendor-country" /></label><label>Currency code<input required minLength={3} maxLength={3} name="currency" defaultValue="UGX" placeholder="UGX" data-testid="input-vendor-currency" /></label></div><fieldset className="method-fieldset"><legend>Payment methods</legend><label className="check-option"><input type="checkbox" name="methods" value="MTN Mobile Money" onChange={() => setMethodError('')} /> MTN Mobile Money</label><label className="check-option"><input type="checkbox" name="methods" value="Airtel Money" onChange={() => setMethodError('')} /> Airtel Money</label><label className="check-option"><input type="checkbox" name="methods" value="Bank transfer" onChange={() => setMethodError('')} /> Bank transfer</label></fieldset>{methodError && <p className="form-error">{methodError}</p>}{apply.isError && <p className="form-error">Could not submit your application. Try again.</p>}<div className="form-actions"><button type="button" className="button button-outline" onClick={() => setShowApplication(false)}>Cancel</button><button type="submit" className="button button-green" disabled={apply.isPending}>{apply.isPending ? 'Submitting…' : 'Submit application'} <ArrowRight size={15} /></button></div><p className="form-footnote">New applications are pending review and will not appear as approved listings.</p></form></Modal>}
  </AppFrame>;
}
function countryName(code: string) { const countries: Record<string, string> = { UG: 'Uganda', KE: 'Kenya', NG: 'Nigeria', GH: 'Ghana', US: 'United States' }; return countries[code] || code; }

function RecordsPage() {
  const records = useGetRecords({ query: { queryKey: getGetRecordsQueryKey() } });
  const [search, setSearch] = useState('');
  const filtered = records.data?.filter((r) => `${r.title} ${r.recordType} ${r.status}`.toLowerCase().includes(search.toLowerCase())) || [];
  return <AppFrame title="All records" eyebrow="YOUR ACTUAL FINANCIAL RECORDS">
    <div className="page-intro"><p>A single, searchable view of records saved in your workspace. Each item reflects what exists, not an estimate.</p><span className="intro-stamp"><BriefcaseBusiness size={17} /> RECORDS</span></div>
    <div className="records-toolbar"><label className="records-search"><Search size={16} /><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search records" aria-label="Search records" data-testid="input-search-records" /></label><span className="records-count">{records.data?.length ?? 0} records</span></div>
    {records.isLoading ? <StatePanel kind="loading" title="Loading records" text="Your financial record list is on its way." /> : records.isError ? <StatePanel kind="error" title="Records did not load" text="We could not reach the records list." retry={() => records.refetch()} /> : !records.data?.length ? <EmptyState icon={<BriefcaseBusiness size={22} />} title="Your records will live here." text="Invoice drafts, payroll profiles, and vendor applications you save will appear in this list." /> : !filtered.length ? <EmptyState icon={<Search size={22} />} title="Nothing found for that search." text="Try a different title or record type." action={<button className="button button-outline" onClick={() => setSearch('')}>Clear search</button>} /> : <div className="records-list">{filtered.map((record) => <article className="record-row" key={record.id} data-testid={`row-record-${record.id}`}><span className={`record-type-icon type-${record.recordType}`}>{record.recordType === 'invoice' ? <FileText size={17} /> : record.recordType === 'payroll_profile' ? <Users size={17} /> : <Globe2 size={17} />}</span><span className="record-main"><b>{record.title}</b><small>{recordTypeName(record.recordType)} <span>·</span> Created {formatDate(record.createdAt)}</small></span><span className={`status-pill ${record.status.toLowerCase() === 'draft' ? 'status-draft' : record.status.toLowerCase() === 'pending' ? 'status-pending' : 'status-muted'}`}><span />{record.status}</span><span className="record-date">{formatDate(record.createdAt)}</span></article>)}</div>}
    <div className="honesty-note"><ShieldCheck size={18} /><span><b>Actual records only.</b> This list is populated by records stored in your workspace. It does not show estimated balances, sent invoices, or completed transfers.</span></div>
  </AppFrame>;
}
function recordTypeName(type: string) { return type === 'payroll_profile' ? 'Payroll profile' : type === 'vendor_application' ? 'Vendor application' : 'Invoice'; }

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access your workspace' } }, signUp: { start: { title: 'Create your workspace', subtitle: 'A clearer home for your work' } } }} routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}>
    <ClerkQueryClientCacheInvalidator />
    <PageMetadata />
    <Switch>
      <Route path="/" component={HomePage} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/app"><Protected><WorkspaceSetup /></Protected></Route>
      <Route path="/app/invoices"><Protected><InvoicesPage /></Protected></Route>
      <Route path="/app/payroll"><Protected><PayrollPage /></Protected></Route>
      <Route path="/app/treasury"><Protected><TreasuryPage /></Protected></Route>
      <Route path="/app/exchange"><Protected><ExchangePage /></Protected></Route>
      <Route path="/app/records"><Protected><RecordsPage /></Protected></Route>
      <Route><NotFound /></Route>
    </Switch>
  </ClerkProvider>;
}

function PageMetadata() {
  const [location] = useLocation();
  useEffect(() => {
    const pages: Record<string, { title: string; description: string }> = {
      '/': {
        title: 'Global Finance for Freelancers and Teams | Trezu',
        description: 'Organize invoice drafts, payroll profiles, treasury preferences, and vendor applications in one finance workspace for freelancers and remote businesses.',
      },
      '/sign-in': { title: 'Sign in to Trezu', description: 'Sign in to your Trezu financial workspace.' },
      '/sign-up': { title: 'Create a Trezu workspace', description: 'Create a Trezu workspace for your freelance work or remote business.' },
      '/app': { title: 'Workspace overview | Trezu', description: 'See your saved finance records and workspace setup.' },
      '/app/invoices': { title: 'Invoice drafts | Trezu', description: 'Create and manage saved invoice drafts in Trezu.' },
      '/app/payroll': { title: 'Payroll records | Trezu', description: 'Manage employee compensation and payment preferences in Trezu.' },
      '/app/treasury': { title: 'Treasury preferences | Trezu', description: 'Set and manage internal treasury allocation preferences in Trezu.' },
      '/app/exchange': { title: 'Approved vendor exchange | Trezu', description: 'Browse approved vendor listings and apply to join the Trezu exchange.' },
      '/app/records': { title: 'Financial records | Trezu', description: 'Search saved invoice, payroll, and vendor application records in Trezu.' },
    };
    const page = pages[location] ?? { title: 'Trezu', description: 'Trezu global financial workspace.' };
    document.title = page.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', page.description);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', page.title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', page.description);
    document.querySelector('meta[name="twitter:title"]')?.setAttribute('content', page.title);
    document.querySelector('meta[name="twitter:description"]')?.setAttribute('content', page.description);
    document.querySelector('meta[name="robots"]')?.setAttribute('content', location.startsWith('/app') ? 'noindex, nofollow' : 'index, follow');
  }, [location]);
  return null;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUser = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (previousUser.current !== undefined && previousUser.current !== userId) client.clear();
      previousUser.current = userId;
    });
    return unsubscribe;
  }, [addListener, client]);
  return null;
}

function App() {
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
  return <QueryClientProvider client={queryClient}><WouterRouter base={basePath}><RoutedErrorBoundary><ClerkRoutes /></RoutedErrorBoundary></WouterRouter></QueryClientProvider>;
}

export default App;
