import { wire as readyOrderWire } from "./liveSession.readyOrder.fixture";

// Captured A -> B replacement on one durable session, with separate bindings.
const durableSessionId = "durable-00000001-4f2a-9c31";
const oldBinding = "DUISVUHU3CWTE6FHCN5MMUKLLD";
const newBinding = "NADNPMIMEZQ7B22YU2NNHID4QK";
const first = {
  ...readyOrderWire.firstOverview[0],
  bindingId: oldBinding,
  last_activity_ms: 1790446082773,
};
const oldUpdate = {
  ...first,
  last_activity_ms: 1790446082784,
};
const replacement = {
  ...first,
  id: "B",
  sessionId: "B",
  title: "B",
  bindingId: newBinding,
  replacesSessionId: "A",
  last_activity_ms: 1790446082810,
  running: { agents: 0, tasks: 0, dag: 0 },
};
const current = {
  ...replacement,
  last_activity_ms: 1790446082814,
  running: { agents: 2, tasks: 2, dag: 0 },
};

export const crossChatWire = {
  hello: { ...readyOrderWire.hello, instanceId: "TYEMJZ7RMUOPNOL7H525ID2EEO" },
  ready: { ...readyOrderWire.ready, bindingId: oldBinding },
  newReady: { ...readyOrderWire.newReady, sessionId: "B", bindingId: newBinding },
  firstOverview: [first, oldUpdate],
  returnedOverview: [oldUpdate, replacement, current],
  task: { ...readyOrderWire.task, bindingId: oldBinding, revision: 1790446082774 },
  dag: { ...readyOrderWire.dag, bindingId: oldBinding, revision: 1790446082775 },
  activity: { ...readyOrderWire.activity, bindingId: oldBinding, revision: 1790446082776 },
  freshTask: { ...readyOrderWire.freshTask, sessionId: "B", bindingId: newBinding, revision: 1790446082815 },
  freshDag: { ...readyOrderWire.freshDag, sessionId: "B", bindingId: newBinding, revision: 1790446082816 },
  freshActivity: { ...readyOrderWire.freshActivity, sessionId: "B", bindingId: newBinding, revision: 1790446082817 },
  freshAttachedFrames: [
    { ...readyOrderWire.freshTask, sessionId: "B", bindingId: newBinding, revision: 1790446082815 },
    { ...readyOrderWire.freshDag, sessionId: "B", bindingId: newBinding, revision: 1790446082816 },
    { ...readyOrderWire.freshActivity, sessionId: "B", bindingId: newBinding, revision: 1790446082817 },
  ],
  durableSessionId,
} as const;
