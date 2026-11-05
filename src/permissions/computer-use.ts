// Nenhuma solicitação de computer use é executável até existir isolamento de apps por tarefa.
type ComputerUseRequest = { needs?: readonly string[]; apps?: unknown; executor: string };

const forbidden = new Set([
  "mail", "com.apple.mail", "messages", "imessage", "com.apple.ichat", "com.apple.messages", "com.apple.mobilesms",
  "keychainaccess", "keychain", "com.apple.keychainaccess", "1password", "1password7", "1password8",
  "com.agilebits.onepassword", "com.agilebits.onepassword7", "com.1password.1password", "com.1password.1password7", "com.1password.1password8",
  "bitwarden", "com.bitwarden.desktop", "com.bitwarden.bitwarden", "systemsettings", "systempreferences",
  "com.apple.systempreferences", "com.apple.systemsettings", "terminal", "com.apple.terminal",
  "iterm", "iterm2", "com.googlecode.iterm2", "com.iterm2.iterm2",
  "codex", "com.openai.codex", "chatgpt", "com.openai.chat", "com.openai.chatgpt",
]);

function appKey(app: string): string {
  const name = app.trim().split(/[\\/]/).pop() ?? "";
  return name.toLowerCase().replace(/\.(app|exe)$/i, "").replace(/[\s_-]+/g, "");
}

export function computerUseBlockReason(req: ComputerUseRequest, enabled: boolean, platform: string = process.platform): string | null {
  const requested = req.needs?.includes("computer_use") === true;
  if (!requested) return req.apps !== undefined ? 'apps exige needs incluindo "computer_use"' : null;
  if (enabled !== true) return "computer use exige computerUse.enabled=true";
  if (req.executor !== "codex") return "computer use exige executor codex";
  if (platform !== "darwin") return "computer use ainda não validado nesta plataforma; suporte planejado somente para macOS";
  if (!Array.isArray(req.apps) || req.apps.length < 1 || req.apps.length > 20 ||
      req.apps.some((app) => typeof app !== "string" || app.length > 200 || !app.trim())) {
    return "computer use exige apps não vazios, com até 20 nomes de até 200 caracteres";
  }
  const denied = req.apps.find((app: string) => forbidden.has(appKey(app)));
  if (denied !== undefined) return `computer use: app proibido: ${denied}`;
  return "computer use indisponível: a restrição de apps por tarefa ainda não é imposta pelo runtime";
}
