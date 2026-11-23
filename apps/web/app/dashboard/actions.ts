"use server";

import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { renameUsername } from "@/lib/trading-api";

/** Changes the signed-in player's unique username (their country label). Failures redirect with a short reason KEY. */
export async function changeUsername(formData: FormData) {
  const username = String(formData.get("username") ?? "").trim();
  const supabase = await createSupabaseServerClient();
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  if (!session) redirect("/sign-in");
  const problem = await renameUsername(session.access_token, username);
  redirect(problem ? `/dashboard?username_error=${problem}` : "/dashboard?username=saved");
}
