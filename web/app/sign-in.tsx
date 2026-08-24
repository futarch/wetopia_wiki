"use client";

import { useState } from "react";
import { signIn, signUp } from "../lib/auth-client.ts";

export default function SignIn() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res =
      mode === "in"
        ? await signIn.email({ email, password })
        : await signUp.email({ email, password, name: name || email.split("@")[0] });
    setBusy(false);
    if (res.error) {
      setError(
        res.error.message ??
          (mode === "in" ? "Connexion impossible." : "Création de compte impossible."),
      );
    }
  };

  return (
    <div className="signin">
      <form onSubmit={submit}>
        <h1>Wetopia</h1>
        <p className="sub">Le wiki de la communauté, tenu par un agent.</p>

        {mode === "up" && (
          <label>
            Nom
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
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
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
          />
        </label>

        {error && <p className="error">⚠ {error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "…" : mode === "in" ? "Se connecter" : "Créer le compte"}
        </button>

        <button type="button" className="link" onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); }}>
          {mode === "in" ? "Créer un compte" : "J'ai déjà un compte"}
        </button>

        {mode === "up" && <p className="hint">Mot de passe : 10 caractères minimum.</p>}
      </form>
    </div>
  );
}
