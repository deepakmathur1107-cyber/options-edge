/**
 * SubscriptionGate.jsx
 * Wraps protected content. Admins pass through unconditionally.
 * Non-subscribers see the paywall/upgrade prompt.
 */

import { useAuth } from "@clerk/clerk-react";
import { isAdmin } from "../lib/adminBypass";
import useSubscription from "../lib/useSubscription";

export default function SubscriptionGate({ children, fallback = null }) {
  const { userId } = useAuth();
  const { active, loading } = useSubscription();

  // Admins always pass through
  if (isAdmin(userId)) return <>{children}</>;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32 text-zinc-400 text-sm">
        Checking subscription…
      </div>
    );
  }

  if (!active) {
    return (
      fallback ?? (
        <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
          <p className="text-zinc-300 text-lg font-semibold">
            Options Edge Pro required
          </p>
          <p className="text-zinc-500 text-sm max-w-sm">
            Start your 7-day free trial to access the scanner, live Greeks, and
            cloud trade log.
          </p>
          <a
            href="/pricing"
            className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold rounded-lg transition-colors text-sm"
          >
            Start Free Trial →
          </a>
        </div>
      )
    );
  }

  return <>{children}</>;
}
