import {
  AppShell,
  BrandProvider,
  Button,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import { BookUser, CalendarDays, CalendarX, DoorOpen, FileCode, KeyRound, LogIn, LogOut, Share2, UserRound, Users } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, MfaSetupRequired, Unauthorized, type Call, type CalendarSession, type DirectoryList, type ProductLink } from "./api.ts";
import { CalendarPage } from "./Calendar.tsx";
import { ContactsPage } from "./Contacts.tsx";
import type { DialogStart } from "./EventDialog.tsx";
import type { Guest } from "./events.ts";
import { useT } from "./i18n.ts";
import { RoomsPage } from "./Rooms.tsx";
import { SettingsPage } from "./Settings.tsx";
import { SharingPage } from "./Sharing.tsx";

const PAGES = ["rooms", "contacts", "sharing", "settings", "account", "members", "signin", "tokens"] as const;
type Page = "calendar" | (typeof PAGES)[number];
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["calendar", ...PAGES];
function parseRoute(path: string): Page {
  const page = path.replace(/^\//, "").split("/")[0] ?? "";
  return (PAGES as readonly string[]).includes(page) ? (page as Page) : "calendar";
}

/** Data loading with the session; when it ends, the sign-in screen comes back. */
function useApi(): Call {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await api<T>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AdminPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("admin.adminsOnly")}>{t("admin.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`admin.${page}`)}
        description={t(`admin.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("admin.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

/** Someone signed in without a mailbox, such as an admin who only manages Calendar. */
function NoMailbox({ message, manager }: { message: string; manager: boolean }) {
  const t = useT();
  return (
    <EmptyState
      icon={<CalendarX />}
      title={t("calendar.noMailbox")}
      action={
        manager && (
          <Button variant="secondary" onClick={() => navigate("/settings")}>
            {t("calendar.toSettings")}
          </Button>
        )
      }
    >
      {message}
    </EmptyState>
  );
}

function Product() {
  const t = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const page = parseRoute(usePath());
  const call = useApi();
  const [session, setSession] = useState<CalendarSession>();
  const [directory, setDirectory] = useState<DirectoryList>();
  const [sessionError, setSessionError] = useState<string>();
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const [intent, setIntent] = useState<DialogStart | null>(null);

  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "calendar" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
    void call<CalendarSession>("/api/v1/session").then(setSession, (e: Error) => setSessionError(e instanceof ApiError ? e.message : String(e)));
    void call<DirectoryList>("/api/v1/directory").then(setDirectory, () => {});
  }, [call]);

  const manager = can("viewer");
  const nav = [
    { id: "calendar", label: t("nav.calendar"), icon: CalendarDays },
    { id: "rooms", label: t("nav.rooms"), icon: DoorOpen },
    { id: "contacts", label: t("nav.contacts"), icon: BookUser },
    { id: "sharing", label: t("nav.sharing"), icon: Share2 },
    ...(manager ? [{ id: "settings", label: t("nav.settings"), icon: FileCode }] : []),
  ];
  const footerNav = [
    ...(can("admin")
      ? [
          { id: "members", label: t("nav.members"), icon: Users },
          { id: "signin", label: t("nav.signIn"), icon: LogIn },
          { id: "tokens", label: t("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: t("nav.account"), icon: UserRound },
  ];
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const invite = (guests: Guest[]) => {
    setIntent({ date: new Date().toISOString().slice(0, 10), minutes: 10 * 60, guests });
    navigate("/calendar");
  };
  const needsMailbox = (render: (s: CalendarSession, d: DirectoryList) => ReactNode) =>
    session && directory ? (
      render(session, directory)
    ) : sessionError ? (
      <NoMailbox message={sessionError} manager={manager} />
    ) : (
      <p className="text-sm text-fg-muted">{t("calendar.loading")}</p>
    );

  return (
    <AppShell
      product="calendar"
      about={colophon}
      nav={nav}
      activeNav={page}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {page === "calendar" ? (
        needsMailbox((s, d) => <CalendarPage call={call} session={s} directory={d} intent={intent} onIntentDone={() => setIntent(null)} />)
      ) : page === "rooms" ? (
        needsMailbox(() => (
          <RoomsPage
            call={call}
            onBook={(room, date) => {
              setIntent({ date, minutes: 10 * 60, guests: [{ email: room, name: "" }] });
              navigate("/calendar");
            }}
          />
        ))
      ) : page === "contacts" ? (
        needsMailbox((s, d) => <ContactsPage call={call} session={s} directory={d} onInvite={(guests) => invite(guests)} />)
      ) : page === "sharing" ? (
        needsMailbox((s, d) => <SharingPage call={call} session={s} directory={d} />)
      ) : page === "settings" && manager ? (
        <SettingsPage call={call} />
      ) : page === "account" || page === "members" || page === "signin" || page === "tokens" ? (
        <AdminPage page={page} />
      ) : (
        <EmptyState title={t("admin.adminsOnly")}>{t("admin.askAnAdmin")}</EmptyState>
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Calendar">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
