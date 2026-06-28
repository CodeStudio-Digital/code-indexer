/** Portal router + authenticated shell (sidebar nav). Public routes (login, OAuth
 *  handoff, email links) render bare; everything else requires a session. */
import { type ReactNode } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Cloud, LogOut, Laptop, CreditCard, FolderGit2, FileCode2, Users, ShieldCheck, LayoutDashboard } from 'lucide-react';
import { useAuth } from './lib/auth.js';
import { cn, Spinner } from './lib/ui.js';
import { LoginPage } from './pages/Login.js';
import { AuthDonePage } from './pages/AuthDone.js';
import { OverviewPage } from './pages/Overview.js';
import { DevicesPage } from './pages/Devices.js';
import { BillingPage } from './pages/Billing.js';
import { BillingSuccessPage } from './pages/BillingSuccess.js';
import { BillingCancelPage } from './pages/BillingCancel.js';
import { ProjectsPage } from './pages/Projects.js';
import { ApisPage } from './pages/Apis.js';
import { TeamsPage } from './pages/Teams.js';
import { SecurityPage } from './pages/Security.js';
import { VerifyEmailPage } from './pages/VerifyEmail.js';
import { ResetPasswordPage } from './pages/ResetPassword.js';
import { ForgotPage } from './pages/Forgot.js';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/devices', label: 'Devices', icon: Laptop },
  { to: '/projects', label: 'Projects', icon: FolderGit2 },
  { to: '/apis', label: 'API docs', icon: FileCode2 },
  { to: '/teams', label: 'Teams', icon: Users },
  { to: '/billing', label: 'Billing', icon: CreditCard },
  { to: '/security', label: 'Security', icon: ShieldCheck },
];

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/done" element={<AuthDonePage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/apis" element={<ApisPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/billing/success" element={<BillingSuccessPage />} />
        <Route path="/billing/cancel" element={<BillingCancelPage />} />
        <Route path="/security" element={<SecurityPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { account, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-muted-foreground" />
      </div>
    );
  }
  if (!account) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

// Shell renders the nav + an <Outlet/>-style content area. Since the protected
// routes are nested, we render children via a layout that wraps the matched route.
function Shell() {
  const { account, signOut } = useAuth();
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl gap-6 px-4 py-6 md:px-6">
      <aside className="hidden w-56 shrink-0 flex-col gap-1 md:flex">
        <div className="mb-4 flex items-center gap-2 px-2">
          <Cloud className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold">CodeStudio</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                  isActive ? 'bg-accent text-accent-foreground font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )
              }
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 px-2 pt-4">
          <div className="truncate text-xs text-muted-foreground" title={account?.email}>
            {account?.email}
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
