import { useAccountSession } from "../../cloud/accountSessionContext";
import { toastManager } from "../ui/toast";

/** Sign In and Create Account starters that report a failure to start as a toast. */
export function useAccountSignInActions() {
  const { signIn, signUp } = useAccountSession();
  const report = (cause: unknown) =>
    toastManager.add({
      type: "error",
      title: "Could not start sign-in",
      description: cause instanceof Error ? cause.message : "Try again in a moment.",
    });
  return {
    startSignIn: () => void signIn().catch(report),
    startSignUp: () => void signUp().catch(report),
  };
}
