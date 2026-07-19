import { codexLoginDeviceCode, loadCodexCredential, codexLogout, type DeviceCodePrompt } from "../llm/codex-auth.ts";
import { claudeTokenStatus, setClaudeToken, clearClaudeToken } from "../llm/claude-auth.ts";

// Shared handler for the `/codex` and `/claude` auth commands on every channel. The channel
// passes a `postFollowUp` that pushes an unsolicited message to the same chat/thread (via the
// adapter's send), used by the Codex device-code flow to report success/failure minutes later.
export interface AuthCommandParams {
  provider: "codex" | "claude";
  args: string;
  isDm: boolean;
  postFollowUp: (text: string) => void;
  // Called after a successful login/logout (or Claude set-token) so the host can ensure the
  // provider exists and re-run model discovery — otherwise the provider's models only appear
  // in /model after a restart or the next 6h refresh.
  onAuthChanged?: (provider: "codex" | "claude") => void | Promise<void>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DM_ONLY = "Cette commande n'est disponible qu'en message privé avec le bot.";

export async function handleAuthCommand(p: AuthCommandParams): Promise<string> {
  const parts = p.args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? "status").toLowerCase();
  return p.provider === "codex" ? handleCodex(sub, p) : handleClaude(sub, parts, p);
}

async function handleCodex(sub: string, p: AuthCommandParams): Promise<string> {
  switch (sub) {
    case "status": {
      const cred = await loadCodexCredential();
      if (!cred) return "Codex : non connecté. Utilise `/codex login` (en privé) pour te connecter.";
      const mins = Math.round((cred.expires - Date.now()) / 60000);
      return `Codex : connecté (compte ${cred.accountId}). Token ${mins > 0 ? `valide ~${mins} min` : "expiré (rafraîchi au prochain appel)"}.`;
    }
    case "logout":
      if (!p.isDm) return DM_ONLY;
      await codexLogout();
      await p.onAuthChanged?.("codex");
      return "Codex : déconnecté.";
    case "login":
      if (!p.isDm) return DM_ONLY;
      return startCodexLogin(p.postFollowUp, () => p.onAuthChanged?.("codex"));
    default:
      return "Usage : `/codex login` | `/codex status` | `/codex logout`";
  }
}

async function startCodexLogin(
  postFollowUp: (text: string) => void,
  onChanged?: () => void | Promise<void>,
): Promise<string> {
  try {
    let prompted = false;
    const prompt = await new Promise<DeviceCodePrompt>((resolve, reject) => {
      codexLoginDeviceCode((pr) => {
        prompted = true;
        resolve(pr);
      })
        .then(async (cred) => {
          // Discovery needs the token that only just landed; run it before telling the user,
          // so the ChatGPT models are already in /model when they get the confirmation.
          await Promise.resolve(onChanged?.()).catch(() => {});
          postFollowUp(`Codex : connecté (compte ${cred.accountId}). Les modèles ChatGPT sont dans /model.`);
        })
        // A failure before the code was shown is surfaced as the immediate reply; a failure
        // after (poll timeout/denied) can only be reported via the follow-up.
        .catch((err) => {
          if (prompted) postFollowUp(`Codex : échec du login (${errMsg(err)}).`);
          else reject(err);
        });
    });
    const mins = Math.round(prompt.expiresInSeconds / 60);
    return [
      "Connexion Codex (abonnement ChatGPT) :",
      `1. Ouvre ${prompt.verificationUri}`,
      `2. Entre le code : ${prompt.userCode}`,
      "3. Approuve avec ton compte ChatGPT",
      `(expire dans ~${mins} min — je te préviens ici une fois connecté)`,
    ].join("\n");
  } catch (err) {
    return `Impossible de démarrer le login Codex : ${errMsg(err)}`;
  }
}

async function handleClaude(sub: string, parts: string[], p: AuthCommandParams): Promise<string> {
  switch (sub) {
    case "status": {
      const st = await claudeTokenStatus();
      if (!st.present) return "Claude : non connecté. Voir `/claude login`.";
      return `Claude : connecté (source ${st.source}, ${st.masked}).`;
    }
    case "set-token":
    case "token": {
      if (!p.isDm) return DM_ONLY;
      const token = parts.slice(1).join(" ").trim();
      if (!token) return "Usage : `/claude set-token <token>` (génère-le avec `claude setup-token`).";
      await setClaudeToken(token);
      await p.onAuthChanged?.("claude");
      return "Claude : token enregistré (modèles dans /model). Pense à supprimer le message contenant le token.";
    }
    case "logout":
      if (!p.isDm) return DM_ONLY;
      await clearClaudeToken();
      await p.onAuthChanged?.("claude");
      return "Claude : token supprimé.";
    case "login":
      return [
        "Le login Claude passe par l'outil officiel `claude setup-token` (navigateur), qui ne peut",
        "pas tourner depuis le chat. Deux options :",
        "- sur le serveur : `my-claw claude login` (dans un terminal) ;",
        "- ailleurs : génère le token avec `claude setup-token`, puis envoie-le ici avec",
        "  `/claude set-token <token>` (en privé).",
      ].join("\n");
    default:
      return "Usage : `/claude login` | `/claude set-token <token>` | `/claude status` | `/claude logout`";
  }
}
