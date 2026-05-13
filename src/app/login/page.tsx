import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE_NAME, isPasswordLoginEnabled, verifyAuthToken } from "../../../lib/auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

type LoginSearchParams = {
  next?: string | string[];
};

export default async function LoginPage({ searchParams = {} }: { searchParams?: LoginSearchParams }) {
  const nextPath = getSafeNextPath(searchParams.next);

  if (!isPasswordLoginEnabled()) {
    redirect("/");
  }

  const session = (await cookies()).get(AUTH_COOKIE_NAME)?.value;
  if (await verifyAuthToken(session)) {
    redirect(nextPath);
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md items-center">
      <section className="w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-sm font-medium text-slate-500">MediaScout DE</p>
          <h2 className="mt-1 text-2xl font-bold text-slate-900">Login</h2>
        </div>
        <LoginForm nextPath={nextPath} />
      </section>
    </div>
  );
}

function getSafeNextPath(next?: string | string[]) {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) {
    return "/";
  }

  return value;
}
