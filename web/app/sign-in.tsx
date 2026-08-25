"use client";

import { useState } from "react";
import { signIn } from "../lib/auth-client.ts";

/**
 * Sign-in only.
 *
 * There is no sign-up form on purpose: this wiki has a fixed, small membership,
 * and a public "create an account" button invites attempts that can only fail.
 * Accounts are provisioned deliberately — the server-side allowlist
 * (WETOPIA_ALLOWED_EMAILS) remains the actual guard, this simply stops
 * advertising a door that is not open.
 */
export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await signIn.email({ email, password });
    setBusy(false);
    if (res.error) setError("Adresse ou mot de passe incorrect.");
  };

  return (
    <div className="signin">
      <form onSubmit={submit}>
        <h1>Wetopia</h1>

        <label>
          Adresse e-mail
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label>
          Mot de passe
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && <p className="error">⚠ {error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "…" : "Se connecter"}
        </button>
      </form>
    </div>
  );
}
