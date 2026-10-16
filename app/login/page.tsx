import Link from "next/link";
import { loginAction } from "@/app/actions/auth";
import { Flash } from "@/components/ui";
import { PasswordInput } from "@/components/PasswordField";
import PopupMessage from "@/components/PopupMessage";

// Pop-ups raised by loginAction / verifyCodeAction for buyers an admin has not
// approved. Fixed texts keyed by a short code, so nothing from the URL is shown.
const NOTICES: Record<string, { title: string; body: string; actionLabel?: string; actionHref?: string }> = {
  awaiting: {
    title: "Thanks, your email is confirmed",
    body: "Your account is now waiting for approval from our team. We will email you as soon as it is approved, and then you can sign in.",
  },
  "not-approved": {
    title: "Your account has not been approved",
    body: "Our team still needs to approve your account before you can sign in. We will email you as soon as it is approved.",
  },
  rejected: {
    title: "Your account has not been approved",
    body: "You cannot sign in with this account. If you think this is a mistake, contact us.",
    actionLabel: "Contact us",
    actionHref: "mailto:seo@welcometomorrow.io?subject=My%20Link%20Tomorrow%20account",
  },
};

export default async function LoginPage(
  props: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }
) {
  const searchParams = await props.searchParams;
  const code = typeof searchParams.notice === "string" ? searchParams.notice : "";
  const notice = Object.hasOwn(NOTICES, code) ? NOTICES[code] : undefined;
  return (
    <div className="mx-auto max-w-md">
      {notice && <PopupMessage {...notice} />}
      <div className="card">
        <h1 className="h2 mb-1">Sign in</h1>
        <p className="muted mb-5">Welcome back to Link Tomorrow.</p>
        <Flash searchParams={searchParams} />
        <form action={loginAction}>
          <label className="field">
            <span>Email</span>
            <input className="input" type="email" name="email" required autoComplete="email" />
          </label>
          <PasswordInput />
          <button className="btn-primary w-full" type="submit">
            Sign in
          </button>
        </form>
        <p className="muted mt-4 text-sm">
          New here? <Link href="/register" className="text-wt-green">Create a buyer account</Link>
        </p>
        <p className="muted mt-1 text-sm">
          <Link href="/forgot-password" className="text-white/70 hover:text-white">Forgot password?</Link>
        </p>
      </div>
    </div>
  );
}
