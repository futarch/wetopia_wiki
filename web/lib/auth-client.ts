"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
export const { signIn, signUp, signOut, useSession } = authClient;

/** What the interface needs to know about whoever is signed in. */
export interface Viewer {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * Typed view of the session.
 *
 * better-auth infers the session shape from the server instance, which this
 * module must not import: `lib/server/auth.ts` pulls in the SQL driver, and
 * that has no business in a browser bundle. So the shape is declared here and
 * the cast is kept to this one place instead of spreading through the UI.
 */
export function useViewer(): { viewer: Viewer | null; isPending: boolean } {
  const { data, isPending } = useSession();
  const viewer = (data as { user?: Viewer } | null | undefined)?.user ?? null;
  return { viewer, isPending };
}
