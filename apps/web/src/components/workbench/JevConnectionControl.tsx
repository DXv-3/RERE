import { useEffect, useRef, useState } from "react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type { EnvironmentId, JevConnectionInput } from "@t3tools/contracts";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function JevConnectionControl({
  environmentId,
  configured,
  onChanged,
}: {
  environmentId: EnvironmentId;
  configured: boolean;
  onChanged: () => void;
}) {
  const configure = useAtomCommand(serverEnvironment.routingConfigure, { reportFailure: false });
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const change = async (input: JevConnectionInput) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setKey("");
    try {
      const result = await configure({ environmentId, input });
      if (!mounted.current) return;
      if (result._tag === "Success") onChanged();
      else {
        const failure = Cause.findErrorOption(result.cause);
        setError(
          Option.isSome(failure) && failure.value._tag === "EnvironmentAuthorizationError"
            ? "Only an administrator of this environment can change the Jev connection."
            : "Could not update the Jev connection. Check the key and this environment, then refresh.",
        );
      }
    } catch {
      if (mounted.current)
        setError("Connection interrupted. Refresh Routing to check whether the change was saved.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Jev Connection">
      <h3>Jev Connection</h3>
      <p>
        {configured
          ? "A key is saved for Jev on this environment."
          : "Paste a TypeSafe key (from console.typesafe.ai) or an OpenRouter key to let Jev choose models and skills on this environment."}
      </p>
      <p>
        Requires environment administrator access. Saving a key makes no inference request and does
        not change your coding providers.
      </p>
      {configured ? (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void change({ action: "disconnect" })}
          >
            {busy ? "Disconnecting…" : "Disconnect Jev"}
          </Button>
          <p>
            Disconnect removes this saved key. Accepted requests may finish; receipts and held
            charges are preserved.
          </p>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void change({ action: "connect", key: Redacted.make(key.trim()) });
          }}
        >
          <Input
            aria-label="TypeSafe Or OpenRouter Key For Jev"
            type="password"
            autoComplete="off"
            spellCheck={false}
            maxLength={512}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            disabled={busy}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !key.trim()}>
            {busy ? "Connecting…" : "Connect Jev"}
          </Button>
          <p>
            The key is stored on the selected server and is never returned to clients.
            Authentication is checked when you ask Jev.
          </p>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
