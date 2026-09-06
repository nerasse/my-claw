import type { ServerWebSocket } from "bun";
import { readAppVersion } from "../../core/diagnostics.ts";
import { requestSelfUpdate } from "../../core/self-update.ts";
import { myClawAppLog } from "../../utils/logger.ts";
import { sanitizeThreadId } from "./sessions.ts";
import { withoutEndpoint } from "../../llm/model-ref.ts";
import type {
  MyClawAppAgentsController,
  MyClawAppCommandHandler,
  MyClawAppConfigController,
  MyClawAppInstructionsController,
  MyClawAppJobsController,
  MyClawAppMcpController,
  MyClawAppModelController,
  MyClawAppProvidersController,
  MyClawAppSessionData,
  MyClawAppSkillsController,
  MyClawAppTagsController,
  MyClawAppToolsController,
  MyClawAppUiPrefsController,
  MyClawAppVoiceController,
  MyClawAppWorkspacesController,
} from "./controllers.ts";
import type {
  MyClawAppAgentFileCreate,
  MyClawAppAgentFileDelete,
  MyClawAppAgentFileGet,
  MyClawAppAgentFileSet,
  MyClawAppAgentsConfigGet,
  MyClawAppAgentsContextCapSet,
  MyClawAppAgentsFallbackSet,
  MyClawAppAgentsIterationsSet,
  MyClawAppAgentsModelClear,
  MyClawAppAgentsModelSet,
  MyClawAppAgentsScopeSet,
  MyClawAppAgentsWorkspaceSet,
  MyClawAppConfigGet,
  MyClawAppConfigSet,
  MyClawAppErrorScope,
  MyClawAppInstructionsGet,
  MyClawAppInstructionsLayerSet,
  MyClawAppInstructionsSet,
  MyClawAppJobDelete,
  MyClawAppJobSave,
  MyClawAppJobsRuns,
  MyClawAppMcpAdd,
  MyClawAppMcpEnable,
  MyClawAppMcpRemove,
  MyClawAppModelContextSet,
  MyClawAppProviderEnvRemove,
  MyClawAppProviderEnvRename,
  MyClawAppProviderEnvSet,
  MyClawAppProviderRemove,
  MyClawAppProviderRename,
  MyClawAppProviderUpsert,
  MyClawAppModelUpsert,
  MyClawAppModelRemove,
  MyClawAppServerFrame,
  MyClawAppSkillsTransfer,
  MyClawAppTagsDelete,
  MyClawAppTagsUpsert,
  MyClawAppToolsToggle,
  MyClawAppWorkspacesAdd,
  MyClawAppWorkspacesRemove,
  MyClawAppWorkspacesRename,
  MyClawAppWorkspacesSetPath,
} from "./types.ts";

/**
 * What a settings frame needs from the adapter. These handlers are plain functions over one
 * socket, so what used to be `this` arrives as this object: the controllers exactly as the
 * dispatch read them, plus the two exits every handler shares.
 */
export interface MyClawAppSettingsDeps {
  readonly voice?: MyClawAppVoiceController;
  readonly models?: MyClawAppModelController;
  readonly agents?: MyClawAppAgentsController;
  readonly tags?: MyClawAppTagsController;
  readonly providers?: MyClawAppProvidersController;
  readonly skills?: MyClawAppSkillsController;
  readonly mcp?: MyClawAppMcpController;
  readonly tools?: MyClawAppToolsController;
  readonly instructions?: MyClawAppInstructionsController;
  readonly jobs?: MyClawAppJobsController;
  readonly uiPrefs?: MyClawAppUiPrefsController;
  readonly configEditor?: MyClawAppConfigController;
  readonly workspacesCtrl?: MyClawAppWorkspacesController;
  readonly commandHandler?: MyClawAppCommandHandler;
  sendFrame(ws: ServerWebSocket<MyClawAppSessionData> | undefined, frame: MyClawAppServerFrame): void;
  /** Every device of one owner. What a state change answers with, since it changed it for all of them. */
  broadcastFrame(owner: string, frame: MyClawAppServerFrame): void;
  refuse(
    ws: ServerWebSocket<MyClawAppSessionData>,
    scope: MyClawAppErrorScope,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  sessionIdOf(ws: ServerWebSocket<MyClawAppSessionData>, threadId: string | undefined): { sessionId?: string };
  /** A conversation's status report moved (model, effort, context choice): its open pages are pushed. */
  statusChanged?(owner: string, threadId: string): void;
}

/**
 * Runs the update the timer would have run at the next tick.
 *
 * The answer goes out first and the socket is expected to die a few seconds later, when the unit
 * stops the service. So the frame says what was decided, never what was installed: the version of
 * the `hello` after reconnecting is what tells the owner whether anything moved.
 */
export async function handleUpdateRun(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
): Promise<void> {
  const version = await readAppVersion();
  const outcome = await requestSelfUpdate();
  d.sendFrame(ws, {
    type: "update.result",
    started: outcome.started,
    version,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  });
  await myClawAppLog(outcome.started ? "info" : "warn", "update requested from the app", {
    owner: ws.data.owner,
    device: ws.data.deviceId,
    version,
    started: outcome.started,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.detail ? { detail: outcome.detail } : {}),
  });
}

/**
 * One handler for both frames: a set is only useful if it answers with the resulting state,
 * and the app renders that same state either way.
 */
export async function handleVoiceMode(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  mode: "cloud" | "local" | "auto" | undefined,
): Promise<void> {
  if (!d.voice) {
    await d.refuse(ws, "voice", "voice control unavailable");
    return;
  }
  try {
    if (mode) {
      if (mode !== "cloud" && mode !== "local" && mode !== "auto") {
        await d.refuse(ws, "voice", "invalid voice mode", { mode });
        return;
      }
      await d.voice.setMode(mode);
    }
    // A set moves a machine-wide setting, and a get asks about it: the first is news for every
     // window of the owner, the second only for the asker (docs/my-claw-app-channel.md).
    const state: MyClawAppServerFrame = { type: "voice.mode.result", ...d.voice.status() };
    if (mode) d.broadcastFrame(ws.data.owner, state);
    else d.sendFrame(ws, state);
  } catch (err) {
    await d.refuse(ws, "voice", "voice.mode failed", { mode, error: String(err) });
  }
}

export async function handleUiPrefs(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  prefs: { expandTools?: boolean; expandReasoning?: boolean } | undefined,
): Promise<void> {
  if (!d.uiPrefs) {
    await d.refuse(ws, "uiPrefs", "ui preferences unavailable");
    return;
  }
  try {
    if (prefs) {
      if (typeof prefs.expandTools !== "undefined" && typeof prefs.expandTools !== "boolean") {
        await d.refuse(ws, "uiPrefs", "invalid expandTools", { expandTools: prefs.expandTools });
        return;
      }
      if (typeof prefs.expandReasoning !== "undefined" && typeof prefs.expandReasoning !== "boolean") {
        await d.refuse(ws, "uiPrefs", "invalid expandReasoning", { expandReasoning: prefs.expandReasoning });
        return;
      }
      await d.uiPrefs.set(prefs);
    }
    // A set moves a machine-wide setting, and a get asks about it: the first is news for every
    // window of the owner, the second only for the asker.
    const state: MyClawAppServerFrame = { type: "uiPrefs.result", ...d.uiPrefs.status() };
    if (prefs) d.broadcastFrame(ws.data.owner, state);
    else d.sendFrame(ws, state);
  } catch (err) {
    await d.refuse(ws, "uiPrefs", "uiPrefs failed", { prefs, error: String(err) });
  }
}

export async function handleModelList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.models) {
    await d.refuse(ws, "model", "model control unavailable");
    return;
  }
  try {
    d.sendFrame(ws, { type: "model.list.result", ...d.models.list() });
  } catch (err) {
    await d.refuse(ws, "model", "model.list failed", { error: String(err) });
  }
}

/**
 * A hand-fired discovery. The fresh listing goes out first, so the screen is already showing the
 * new catalogue when the outcome line appears under it.
 */
export async function handleModelRefresh(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.models?.refresh) {
    await d.refuse(ws, "model", "model discovery unavailable");
    return;
  }
  try {
    const outcome = await d.models.refresh();
    // The catalogue is shared, the outcome line belongs to the hand that fired the discovery.
    d.broadcastFrame(ws.data.owner, { type: "model.list.result", ...d.models.list() });
    d.sendFrame(ws, { type: "model.refresh.result", ...outcome });
  } catch (err) {
    await d.refuse(ws, "model", "model.refresh failed", { error: String(err) });
  }
}

/**
 * Writes one declaration, then broadcasts the catalogue it produced.
 *
 * Broadcast, not sent: a declaration changes what every device of this owner may run, and the app
 * never patches its own copy of the list. Answering with the fresh listing is what makes an override
 * visibly take effect on the model it overrides.
 */
export async function handleModelUpsert(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppModelUpsert,
): Promise<void> {
  if (!d.models?.upsert) {
    await d.refuse(ws, "model", "model config unavailable");
    return;
  }
  if (!frame.id) {
    await d.refuse(ws, "model", "invalid model id");
    return;
  }
  try {
    await d.models.upsert(frame);
    d.broadcastFrame(ws.data.owner, { type: "model.list.result", ...d.models.list() });
  } catch (err) {
    await d.refuse(ws, "model", "models.upsert failed", { id: frame.id, error: String(err) });
  }
}

export async function handleModelRemove(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppModelRemove,
): Promise<void> {
  if (!d.models?.remove) {
    await d.refuse(ws, "model", "model config unavailable");
    return;
  }
  if (!frame.id) {
    await d.refuse(ws, "model", "invalid model id");
    return;
  }
  try {
    await d.models.remove(frame.id);
    d.broadcastFrame(ws.data.owner, { type: "model.list.result", ...d.models.list() });
  } catch (err) {
    await d.refuse(ws, "model", "models.remove failed", { id: frame.id, error: String(err) });
  }
}

export async function handleModelEndpoints(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  model: string,
  sort?: "price" | "context" | "output" | "uptime",
): Promise<void> {
  if (!d.models?.endpoints) {
    await d.refuse(ws, "model", "model control unavailable");
    return;
  }
  try {
    const ordering = sort ?? "price";
    d.sendFrame(ws, {
      type: "model.endpoints.result",
      model,
      sort: ordering,
      endpoints: await d.models.endpoints(model, ordering),
    });
  } catch (err) {
    await d.refuse(ws, "model", "model.endpoints failed", { error: String(err) });
  }
}

export async function handleAgentsConfigGet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  _frame: MyClawAppAgentsConfigGet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  try {
    d.sendFrame(ws, d.agents.get());
  } catch (err) {
    await d.refuse(ws, "agents", "agents.config.get failed", { error: String(err) });
  }
}

export async function handleTagsList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.tags) {
    await d.refuse(ws, "tags", "tags unavailable");
    return;
  }
  try {
    d.sendFrame(ws, d.tags.list());
  } catch (err) {
    await d.refuse(ws, "tags", "tags.list failed", { error: String(err) });
  }
}

export async function handleTagsUpsert(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppTagsUpsert,
): Promise<void> {
  if (!d.tags) {
    await d.refuse(ws, "tags", "tags unavailable");
    return;
  }
  if (!frame.name || (!frame.model && (!frame.route || frame.route.length === 0))) {
    await d.refuse(ws, "tags", "invalid tag name or route", { name: frame.name, model: frame.model });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.tags.upsert(frame));
  } catch (err) {
    await d.refuse(ws, "tags", "tags.upsert failed", { name: frame.name, model: frame.model, error: String(err) });
  }
}

export async function handleTagsDelete(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppTagsDelete,
): Promise<void> {
  if (!d.tags) {
    await d.refuse(ws, "tags", "tags unavailable");
    return;
  }
  if (!frame.name) {
    await d.refuse(ws, "tags", "invalid tag name");
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.tags.delete(frame.name));
  } catch (err) {
    await d.refuse(ws, "tags", "tags.delete failed", { name: frame.name, error: String(err) });
  }
}

export async function handleProviderUpsert(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppProviderUpsert,
): Promise<void> {
  if (!d.providers) {
    await d.refuse(ws, "providers", "provider config unavailable");
    return;
  }
  if (!frame.key) {
    await d.refuse(ws, "providers", "invalid provider key");
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.providers.upsert(frame));
  } catch (err) {
    await d.refuse(ws, "providers", "providers.upsert failed", { key: frame.key, error: String(err) });
  }
}

export async function handleProviderRemove(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppProviderRemove,
): Promise<void> {
  if (!d.providers) {
    await d.refuse(ws, "providers", "provider config unavailable");
    return;
  }
  if (!frame.key) {
    await d.refuse(ws, "providers", "invalid provider key");
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.providers.remove(frame.key));
  } catch (err) {
    await d.refuse(ws, "providers", "providers.remove failed", { key: frame.key, error: String(err) });
  }
}

export async function handleProviderRename(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppProviderRename,
): Promise<void> {
  if (!d.providers) {
    await d.refuse(ws, "providers", "provider config unavailable");
    return;
  }
  if (!frame.from || !frame.to) {
    await d.refuse(ws, "providers", "invalid provider rename", { from: frame.from, to: frame.to });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.providers.rename(frame.from, frame.to));
  } catch (err) {
    await d.refuse(ws, "providers", "providers.rename failed", { from: frame.from, to: frame.to, error: String(err) });
  }
}

/** The value is a secret: it never appears in a refusal's data or a log line. */
export async function handleProviderEnvSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppProviderEnvSet,
): Promise<void> {
  if (!d.providers) {
    await d.refuse(ws, "providers", "provider config unavailable");
    return;
  }
  if (!frame.name || !frame.value) {
    await d.refuse(ws, "providers", "invalid env name or value", { name: frame.name });
    return;
  }
  try {
    await d.providers.envSet(frame.name, frame.value);
    d.broadcastFrame(ws.data.owner, await d.providers.envList());
  } catch (err) {
    await d.refuse(ws, "providers", "providers.env.set failed", { name: frame.name, error: String(err) });
  }
}

export async function handleProviderEnvRename(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppProviderEnvRename,
): Promise<void> {
  if (!d.providers) {
    await d.refuse(ws, "providers", "provider config unavailable");
    return;
  }
  if (!frame.from || !frame.to) {
    await d.refuse(ws, "providers", "invalid env rename", { from: frame.from, to: frame.to });
    return;
  }
  try {
    await d.providers.envRename(frame.from, frame.to);
    d.broadcastFrame(ws.data.owner, await d.providers.envList());
  } catch (err) {
    await d.refuse(ws, "providers", "providers.env.rename failed", { from: frame.from, to: frame.to, error: String(err) });
  }
}

export async function handleProviderEnvList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.providers) {
    await d.refuse(ws, "providers", "provider config unavailable");
    return;
  }
  try {
    await d.sendFrame(ws, await d.providers.envList());
  } catch (err) {
    await d.refuse(ws, "providers", "providers.env.list failed", { error: String(err) });
  }
}

export async function handleProviderEnvRemove(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppProviderEnvRemove,
): Promise<void> {
  if (!d.providers) {
    await d.refuse(ws, "providers", "provider config unavailable");
    return;
  }
  if (!frame.name) {
    await d.refuse(ws, "providers", "invalid env name");
    return;
  }
  try {
    await d.providers.envRemove(frame.name);
    d.broadcastFrame(ws.data.owner, await d.providers.envList());
  } catch (err) {
    await d.refuse(ws, "providers", "providers.env.remove failed", { name: frame.name, error: String(err) });
  }
}

export async function handleAgentsModelSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentsModelSet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.model || !frame.agent) {
    await d.refuse(ws, "agents", "invalid agent or model", { agent: frame.agent, model: frame.model });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.agents.setModel(frame.agent, frame.model, frame.effort));
  } catch (err) {
    await d.refuse(ws, "agents", "agents.model.set failed", { agent: frame.agent, model: frame.model, effort: frame.effort, error: String(err) });
  }
}

export async function handleAgentsModelClear(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentsModelClear,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.agent) {
    await d.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.agents.clearModel(frame.agent));
  } catch (err) {
    await d.refuse(ws, "agents", "agents.model.clear failed", { agent: frame.agent, error: String(err) });
  }
}

export async function handleAgentsFallbackSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentsFallbackSet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (typeof frame.model !== "string") {
    await d.refuse(ws, "agents", "invalid fallback model", { model: frame.model });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.agents.setFallback(frame.model));
  } catch (err) {
    await d.refuse(ws, "agents", "agents.fallback.set failed", { model: frame.model, error: String(err) });
  }
}

export async function handleAgentsScopeSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentsScopeSet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.agent || (frame.field !== "skills" && frame.field !== "mcp") || !["inherit", "all", "list"].includes(frame.mode)) {
    await d.refuse(ws, "agents", "invalid scope request", { agent: frame.agent, field: frame.field, mode: frame.mode });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.agents.setScope(frame.agent, frame.field, frame.mode, frame.names ?? []));
  } catch (err) {
    await d.refuse(ws, "agents", "agents.scope.set failed", { agent: frame.agent, error: String(err) });
  }
}

export async function handleAgentsWorkspaceSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentsWorkspaceSet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.agent) {
    await d.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.agents.setWorkspace(frame.agent, frame.workspace));
  } catch (err) {
    await d.refuse(ws, "agents", "agents.workspace.set failed", { agent: frame.agent, error: String(err) });
  }
}

export async function handleAgentsIterationsSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentsIterationsSet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.agent) {
    await d.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.agents.setMaxIterations(frame.agent, frame.value));
  } catch (err) {
    await d.refuse(ws, "agents", "agents.iterations.set failed", { agent: frame.agent, error: String(err) });
  }
}

export async function handleAgentsContextCapSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentsContextCapSet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.agent) {
    await d.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, await d.agents.setContextCap(frame.agent, frame.value));
  } catch (err) {
    await d.refuse(ws, "agents", "agents.contextcap.set failed", { agent: frame.agent, error: String(err) });
  }
}

export async function handleAgentFileGet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentFileGet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.agent) {
    await d.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
    return;
  }
  try {
    const file = await d.agents.fileGet(frame.agent);
    if (!file) {
      await d.refuse(ws, "agents", "not a file-defined agent", { agent: frame.agent });
      return;
    }
    d.sendFrame(ws, file);
  } catch (err) {
    await d.refuse(ws, "agents", "agents.file.get failed", { agent: frame.agent, error: String(err) });
  }
}

export async function handleAgentFileSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentFileSet,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.agent) {
    await d.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
    return;
  }
  try {
    d.sendFrame(ws, await d.agents.fileSet(frame.agent, frame));
    // The roster moved for everyone, but the sha-carrying answer stays with the editor that
    // saved: a window adopting a sha it never asked for is how the next save silently
    // overwrites the draft someone else is typing.
    d.broadcastFrame(ws.data.owner, d.agents.get());
  } catch (err) {
    await d.refuse(ws, "agents", "agents.file.set failed", { agent: frame.agent, error: String(err) });
  }
}

export async function handleAgentFileCreate(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentFileCreate,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.name || !frame.description) {
    await d.refuse(ws, "agents", "name and description are required", { name: frame.name });
    return;
  }
  try {
    d.sendFrame(ws, await d.agents.fileCreate(frame.name, frame.description));
    d.broadcastFrame(ws.data.owner, d.agents.get());
  } catch (err) {
    await d.refuse(ws, "agents", "agents.file.create failed", { name: frame.name, error: String(err) });
  }
}

export async function handleAgentFileDelete(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppAgentFileDelete,
): Promise<void> {
  if (!d.agents) {
    await d.refuse(ws, "agents", "agent defaults unavailable");
    return;
  }
  if (!frame.agent) {
    await d.refuse(ws, "agents", "invalid agent", { agent: frame.agent });
    return;
  }
  try {
    await d.agents.fileDelete(frame.agent);
    d.sendFrame(ws, { type: "agents.file.saved", name: frame.agent, ok: true, sha: "", conflict: false });
    d.broadcastFrame(ws.data.owner, d.agents.get());
  } catch (err) {
    await d.refuse(ws, "agents", "agents.file.delete failed", { agent: frame.agent, error: String(err) });
  }
}

export async function handleToolsToggle(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppToolsToggle,
): Promise<void> {
  if (!d.tools) {
    await d.refuse(ws, "tools", "tool catalog unavailable");
    return;
  }
  if (!frame.name) {
    await d.refuse(ws, "tools", "invalid tool", { name: frame.name });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "tools.list.result", ...(await d.tools.toggle(frame.name, frame.disabled)) });
  } catch (err) {
    await d.refuse(ws, "tools", "tools.toggle failed", { name: frame.name, error: String(err) });
  }
}

export async function handleMcpAdd(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppMcpAdd,
): Promise<void> {
  if (!d.mcp) {
    await d.refuse(ws, "mcp", "MCP status unavailable");
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "mcp.list.result", servers: await d.mcp.add(frame) });
  } catch (err) {
    await d.refuse(ws, "mcp", "mcp.add failed", { name: frame.name, error: String(err) });
  }
}

export async function handleMcpRemove(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppMcpRemove,
): Promise<void> {
  if (!d.mcp) {
    await d.refuse(ws, "mcp", "MCP status unavailable");
    return;
  }
  if (!frame.name) {
    await d.refuse(ws, "mcp", "invalid MCP server", { name: frame.name });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "mcp.list.result", servers: await d.mcp.remove(frame.name) });
  } catch (err) {
    await d.refuse(ws, "mcp", "mcp.remove failed", { name: frame.name, error: String(err) });
  }
}

export async function handleMcpEnable(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppMcpEnable,
): Promise<void> {
  if (!d.mcp) {
    await d.refuse(ws, "mcp", "MCP status unavailable");
    return;
  }
  if (!frame.name) {
    await d.refuse(ws, "mcp", "invalid MCP server", { name: frame.name });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "mcp.list.result", servers: await d.mcp.setEnabled(frame.name, frame.enabled) });
  } catch (err) {
    await d.refuse(ws, "mcp", "mcp.enable failed", { name: frame.name, error: String(err) });
  }
}

export async function handleConfigGet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  _frame: MyClawAppConfigGet,
): Promise<void> {
  if (!d.configEditor) {
    await d.refuse(ws, "config", "config editor unavailable");
    return;
  }
  try {
    const file = await d.configEditor.get();
    d.sendFrame(ws, { type: "config.result", ...file });
  } catch (err) {
    await d.refuse(ws, "config", "config.get failed", { error: String(err) });
  }
}

export async function handleConfigSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppConfigSet,
): Promise<void> {
  if (!d.configEditor) {
    await d.refuse(ws, "config", "config editor unavailable");
    return;
  }
  try {
    // Sender only, and deliberately: the answer carries the new sha and the conflict verdict of
    // *this* write. Pushing it to a window with the editor open would mark its unsaved draft as
    // stored and hand it a sha that defeats the very check meant to protect it.
    d.sendFrame(ws, { type: "config.saved", ...(await d.configEditor.set(frame.sha, frame.content)) });
  } catch (err) {
    await d.refuse(ws, "config", "config.set failed", { error: String(err) });
  }
}

export async function handleSkillsList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.skills) {
    await d.refuse(ws, "skills", "skill catalog unavailable");
    return;
  }
  try {
    d.sendFrame(ws, { type: "skills.list.result", ...d.skills.list() });
  } catch (err) {
    await d.refuse(ws, "skills", "skills.list failed", { error: String(err) });
  }
}

/** The charset of a skill name and of a workspace key on this channel: no separator can reach
 *  the filesystem, which is the first of the two fences (the controller re-resolves the path
 *  against the tier root). Same rule as GET /skills. */
const SKILL_TOKEN = /^[A-Za-z0-9._-]+$/;

export async function handleSkillsTransfer(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppSkillsTransfer,
): Promise<void> {
  if (!d.skills) {
    await d.refuse(ws, "skills", "skill catalog unavailable");
    return;
  }
  const detail = { name: frame.name, source: frame.source, target: frame.target?.source };
  if (frame.source !== "built-in" && frame.source !== "custom" && frame.source !== "workspace") {
    await d.refuse(ws, "skills", "unknown skill tier", detail);
    return;
  }
  if (frame.target?.source !== "custom" && frame.target?.source !== "workspace") {
    await d.refuse(ws, "skills", "a skill can only be written to custom or a workspace", detail);
    return;
  }
  const keys = [frame.name, frame.workspace, frame.target.workspace];
  if (keys.some((key) => key !== undefined && !SKILL_TOKEN.test(key))) {
    await d.refuse(ws, "skills", "invalid skill name or workspace key", detail);
    return;
  }
  try {
    const result = await d.skills.transfer({
      mode: frame.type === "skills.move" ? "move" : "copy",
      source: frame.source,
      name: frame.name,
      ...(frame.workspace ? { workspace: frame.workspace } : {}),
      target: {
        source: frame.target.source,
        ...(frame.target.workspace ? { workspace: frame.target.workspace } : {}),
      },
      ...(frame.overwrite ? { overwrite: true } : {}),
    });
    d.broadcastFrame(ws.data.owner, { type: "skills.list.result", ...result });
  } catch (err) {
    await d.refuse(ws, "skills", `${frame.type} failed`, { ...detail, error: String(err) });
  }
}

export async function handleWorkspacesList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.workspacesCtrl) {
    await d.refuse(ws, "workspaces", "workspace list unavailable");
    return;
  }
  try {
    d.sendFrame(ws, { type: "workspaces.list.result", workspaces: d.workspacesCtrl.list() });
  } catch (err) {
    await d.refuse(ws, "workspaces", "workspaces.list failed", { error: String(err) });
  }
}

export async function handleWorkspacesAdd(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppWorkspacesAdd,
): Promise<void> {
  if (!d.workspacesCtrl) {
    await d.refuse(ws, "workspaces", "workspace list unavailable");
    return;
  }
  if (!frame.key || !frame.path) {
    await d.refuse(ws, "workspaces", "key and path are required", { key: frame.key, path: frame.path });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "workspaces.list.result", workspaces: await d.workspacesCtrl.add(frame.key, frame.path) });
  } catch (err) {
    await d.refuse(ws, "workspaces", "workspaces.add failed", { key: frame.key, error: String(err) });
  }
}

export async function handleWorkspacesRemove(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppWorkspacesRemove,
): Promise<void> {
  if (!d.workspacesCtrl) {
    await d.refuse(ws, "workspaces", "workspace list unavailable");
    return;
  }
  if (!frame.key) {
    await d.refuse(ws, "workspaces", "invalid workspace", { key: frame.key });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "workspaces.list.result", workspaces: await d.workspacesCtrl.remove(frame.key) });
  } catch (err) {
    await d.refuse(ws, "workspaces", "workspaces.remove failed", { key: frame.key, error: String(err) });
  }
}

export async function handleWorkspacesRename(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppWorkspacesRename,
): Promise<void> {
  if (!d.workspacesCtrl) {
    await d.refuse(ws, "workspaces", "workspace list unavailable");
    return;
  }
  if (!frame.from || !frame.to) {
    await d.refuse(ws, "workspaces", "from and to are required", { from: frame.from, to: frame.to });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "workspaces.list.result", workspaces: await d.workspacesCtrl.rename(frame.from, frame.to) });
  } catch (err) {
    await d.refuse(ws, "workspaces", "workspaces.rename failed", { from: frame.from, error: String(err) });
  }
}

export async function handleWorkspacesSetPath(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppWorkspacesSetPath,
): Promise<void> {
  if (!d.workspacesCtrl) {
    await d.refuse(ws, "workspaces", "workspace list unavailable");
    return;
  }
  if (!frame.key || !frame.path) {
    await d.refuse(ws, "workspaces", "key and path are required", { key: frame.key, path: frame.path });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "workspaces.list.result", workspaces: await d.workspacesCtrl.setPath(frame.key, frame.path) });
  } catch (err) {
    await d.refuse(ws, "workspaces", "workspaces.path.set failed", { key: frame.key, error: String(err) });
  }
}

export async function handleMcpList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.mcp) {
    await d.refuse(ws, "mcp", "MCP status unavailable");
    return;
  }
  try {
    d.sendFrame(ws, { type: "mcp.list.result", servers: d.mcp.list() });
  } catch (err) {
    await d.refuse(ws, "mcp", "mcp.list failed", { error: String(err) });
  }
}

export async function handleToolsList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.tools) {
    await d.refuse(ws, "tools", "tool catalog unavailable");
    return;
  }
  try {
    d.sendFrame(ws, { type: "tools.list.result", ...d.tools.list() });
  } catch (err) {
    await d.refuse(ws, "tools", "tools.list failed", { error: String(err) });
  }
}

export async function handleJobsList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.jobs) {
    await d.refuse(ws, "jobs", "job store unavailable");
    return;
  }
  try {
    d.sendFrame(ws, { type: "jobs.list.result", jobs: await d.jobs.list() });
  } catch (err) {
    await d.refuse(ws, "jobs", "jobs.list failed", { error: String(err) });
  }
}

export async function handleJobsRuns(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppJobsRuns,
): Promise<void> {
  if (!d.jobs) {
    await d.refuse(ws, "jobs", "job store unavailable");
    return;
  }
  try {
    d.sendFrame(ws, { type: "jobs.runs.result", jobId: frame.jobId, runs: await d.jobs.runs(frame.jobId) });
  } catch (err) {
    await d.refuse(ws, "jobs", "jobs.runs failed", { jobId: frame.jobId, error: String(err) });
  }
}

export async function handleJobSave(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppJobSave,
): Promise<void> {
  if (!d.jobs) {
    await d.refuse(ws, "jobs", "job store unavailable");
    return;
  }
  if (!frame.prompt.trim() || !frame.schedule.trim()) {
    await d.refuse(ws, "jobs", "prompt and schedule are required", {
      name: frame.name,
      hasPrompt: Boolean(frame.prompt.trim()),
      hasSchedule: Boolean(frame.schedule.trim()),
    });
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "jobs.list.result", jobs: await d.jobs.save(frame) });
  } catch (err) {
    await d.refuse(ws, "jobs", "jobs.save failed", { name: frame.name, id: frame.id, error: String(err) });
  }
}

export async function handleJobDelete(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppJobDelete,
): Promise<void> {
  if (!d.jobs) {
    await d.refuse(ws, "jobs", "job store unavailable");
    return;
  }
  try {
    d.broadcastFrame(ws.data.owner, { type: "jobs.list.result", jobs: await d.jobs.remove(frame.id) });
  } catch (err) {
    await d.refuse(ws, "jobs", "jobs.delete failed", { id: frame.id, error: String(err) });
  }
}

export async function handleInstructionsList(d: MyClawAppSettingsDeps, ws: ServerWebSocket<MyClawAppSessionData>): Promise<void> {
  if (!d.instructions) {
    await d.refuse(ws, "instructions", "instructions unavailable");
    return;
  }
  try {
    d.sendFrame(ws, { type: "instructions.list.result", ...(await d.instructions.list()) });
  } catch (err) {
    await d.refuse(ws, "instructions", "instructions.list failed", { error: String(err) });
  }
}

export async function handleInstructionsGet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppInstructionsGet,
): Promise<void> {
  if (!d.instructions) {
    await d.refuse(ws, "instructions", "instructions unavailable");
    return;
  }
  try {
    const read = await d.instructions.read({
      workspace: frame.workspace,
      ...(frame.file ? { file: frame.file } : {}),
      ...(frame.nested ? { nested: frame.nested } : {}),
      ...(d.sessionIdOf(ws, frame.threadId)),
    });
    if (!read) {
      await d.refuse(ws, "instructions", "unknown instruction file", {
        workspace: frame.workspace,
        file: frame.file ?? frame.nested ?? "",
      });
      return;
    }
    d.sendFrame(ws, { type: "instructions.file", ...read });
  } catch (err) {
    await d.refuse(ws, "instructions", "instructions.get failed", { error: String(err) });
  }
}

export async function handleInstructionsSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppInstructionsSet,
): Promise<void> {
  if (!d.instructions) {
    await d.refuse(ws, "instructions", "instructions unavailable");
    return;
  }
  if (typeof frame.content !== "string") {
    await d.refuse(ws, "instructions", "instructions.set without content");
    return;
  }
  try {
    const res = await d.instructions.write({
      workspace: frame.workspace,
      ...(frame.file ? { file: frame.file } : {}),
      ...(frame.nested ? { nested: frame.nested } : {}),
      ...(d.sessionIdOf(ws, frame.threadId)),
      content: frame.content,
      sha: frame.sha,
    });
    // A refused write answers on its own frame rather than through the error scope: the editor
    // has to tell a conflict apart from a failure, and only one of them means "reload first".
    d.sendFrame(ws, {
      type: "instructions.saved",
      workspace: frame.workspace,
      file: frame.nested ?? frame.file,
      ok: res.ok,
      sha: res.sha,
      conflict: res.conflict,
      ...(res.error ? { error: res.error } : {}),
    });
    if (!res.ok) {
      await myClawAppLog("warn", "instructions.set refused", {
        deviceId: ws.data.deviceId,
        workspace: frame.workspace,
        file: frame.file,
        error: res.error ?? "",
      });
    }
  } catch (err) {
    await d.refuse(ws, "instructions", "instructions.set failed", { error: String(err) });
  }
}

export async function handleInstructionsLayerSet(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppInstructionsLayerSet,
): Promise<void> {
  if (!d.instructions) {
    await d.refuse(ws, "instructions", "instructions unavailable");
    return;
  }
  if (typeof frame.file !== "string" || !frame.file) {
    await d.refuse(ws, "instructions", "instructions.layer.set without file");
    return;
  }
  try {
    // A policy mutation answers with the fresh listing, like every other mutation: the layer
    // screen redraws from what the server stored, never from what it hoped to store.
    const list = await d.instructions.setPolicy(frame.workspace, frame.file, frame.inherit, frame.off);
    d.broadcastFrame(ws.data.owner, { type: "instructions.list.result", ...list });
  } catch (err) {
    await d.refuse(ws, "instructions", "instructions.layer.set failed", {
      workspace: frame.workspace,
      file: frame.file,
      error: String(err),
    });
  }
}

/**
 * One handler for get and set, like voice: the answer is the state the server stored, so the
 * app has no optimistic branch to keep in sync.
 */
export async function handleModel(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  threadId: string,
  modelId: string | undefined,
): Promise<void> {
  const safeThread = sanitizeThreadId(threadId);
  if (!safeThread) {
    await d.refuse(ws, "model", "invalid threadId", { threadId });
    return;
  }
  if (!d.models) {
    await d.refuse(ws, "model", "model control unavailable");
    return;
  }
  try {
    if (modelId !== undefined) {
      // On the bare reference: the app stages a route inside the model string, and no catalogue
      // id carries a pin (docs/model-identity.md).
      const known = d.models.list().models.some((m) => m.id === withoutEndpoint(modelId));
      if (!known) {
        await d.refuse(ws, "model", "unknown model", { threadId: safeThread, model: modelId });
        return;
      }
      const state = await d.models.set(ws.data.owner, safeThread, modelId);
      // The pick belongs to the thread, not to the phone that made it: a browser left open on the
      // same conversation would otherwise keep naming the previous model until it reloads.
      d.broadcastFrame(ws.data.owner, { type: "model.result", threadId: safeThread, ...state });
      d.statusChanged?.(ws.data.owner, safeThread);
      return;
    }
    const state = await d.models.current(ws.data.owner, safeThread);
    d.sendFrame(ws, { type: "model.result", threadId: safeThread, ...state });
  } catch (err) {
    await d.refuse(ws, "model", "model failed", { threadId: safeThread, model: modelId, error: String(err) });
  }
}

export async function handleModelEffort(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  threadId: string,
  level: string,
): Promise<void> {
  const safeThread = sanitizeThreadId(threadId);
  if (!safeThread) {
    await d.refuse(ws, "model", "invalid threadId", { threadId });
    return;
  }
  if (!d.models) {
    await d.refuse(ws, "model", "model control unavailable");
    return;
  }
  try {
    const state = await d.models.setEffort(ws.data.owner, safeThread, level);
    d.broadcastFrame(ws.data.owner, { type: "model.result", threadId: safeThread, ...state });
    d.statusChanged?.(ws.data.owner, safeThread);
  } catch (err) {
    await d.refuse(ws, "model", "model.effort.set failed", { threadId: safeThread, level, error: String(err) });
  }
}

export async function handleModelContext(
  d: MyClawAppSettingsDeps,
  ws: ServerWebSocket<MyClawAppSessionData>,
  frame: MyClawAppModelContextSet,
): Promise<void> {
  const safeThread = sanitizeThreadId(frame.threadId);
  if (!safeThread) {
    await d.refuse(ws, "model", "invalid threadId", { threadId: frame.threadId });
    return;
  }
  if (!d.models) {
    await d.refuse(ws, "model", "model control unavailable");
    return;
  }
  const choice = frame.choice;
  if (choice !== "full" && (typeof choice !== "number" || !Number.isFinite(choice) || choice <= 0)) {
    await d.refuse(ws, "model", "invalid context choice", { threadId: safeThread, choice: String(choice) });
    return;
  }
  try {
    const state = await d.models.setContext(ws.data.owner, safeThread, choice);
    d.broadcastFrame(ws.data.owner, { type: "model.result", threadId: safeThread, ...state });
    d.statusChanged?.(ws.data.owner, safeThread);
  } catch (err) {
    await d.refuse(ws, "model", "model.context.set failed", { threadId: safeThread, error: String(err) });
  }
}

/**
 * The fullscreen status page asks directly, without typing a command: same server-side report,
 * delivered as a dedicated frame so the app does not have to fake a chat.send to get it.
 */
