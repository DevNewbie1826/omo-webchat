export const wire = {
  "activity": {
    "revision": 1790443356224,
    "data": {
      "at": "2026-09-26T00:00:02Z",
      "lastAssistantLine": "old durable activity",
      "nodeId": "node-old",
      "runId": "run-old",
      "taskId": "attached-task-0"
    },
    "name": "omo.dag.activity",
    "sessionId": "A",
    "type": "extensionEvent",
    "bindingId": "OVUU2YICWR3RJURPNOZ6C3D4QS"
  },
  "currentREST": {
    "instanceId": "GCWCAJBPNIAGWFAYWMPHOZXDTF",
    "sessions": [
      {
        "active": false,
        "dag_done": 0,
        "dag_total": 0,
        "done": 0,
        "durableSessionId": "durable-00000001-4f2a-9c31",
        "id": "A",
        "last_activity_ms": 1790443356245,
        "running": {
          "agents": 2,
          "dag": 0,
          "tasks": 2
        },
        "title": "A",
        "truncated": {
          "dag": false,
          "task": false
        }
      }
    ]
  },
  "dag": {
    "revision": 1790443356223,
    "data": {
      "agent_running_count": 7,
      "agent_total_count": 7,
      "parent_session_id": "durable-00000001-4f2a-9c31",
      "run_running_count": 0,
      "run_total_count": 0,
      "running_count": 0,
      "runs": []
    },
    "name": "omo.dag.updated",
    "sessionId": "A",
    "type": "extensionEvent",
    "bindingId": "OVUU2YICWR3RJURPNOZ6C3D4QS"
  },
  "first": {
    "active": false,
    "dag_done": 0,
    "dag_total": 0,
    "done": 0,
    "durableSessionId": "durable-00000001-4f2a-9c31",
    "id": "A",
    "last_activity_ms": 1790443356221,
    "overflow": false,
    "running": {
      "agents": 7,
      "dag": 0,
      "tasks": 7
    },
    "sessionId": "A",
    "title": "A",
    "truncated": {
      "dag": false,
      "task": false
    },
    "type": "sessions.activity"
  },
  "firstOverview": [
    {
      "active": false,
      "dag_done": 0,
      "dag_total": 0,
      "done": 0,
      "durableSessionId": "durable-00000001-4f2a-9c31",
      "id": "A",
      "last_activity_ms": 1790443356221,
      "overflow": false,
      "running": {
        "agents": 7,
        "dag": 0,
        "tasks": 7
      },
      "sessionId": "A",
      "title": "A",
      "truncated": {
        "dag": false,
        "task": false
      },
      "type": "sessions.activity",
      "bindingId": "OVUU2YICWR3RJURPNOZ6C3D4QS"
    }
  ],
  "fresh": {
    "active": false,
    "dag_done": 0,
    "dag_total": 0,
    "done": 0,
    "durableSessionId": "Y",
    "id": "A",
    "last_activity_ms": 1790443356232,
    "overflow": false,
    "running": {
      "agents": 2,
      "dag": 0,
      "tasks": 2
    },
    "sessionId": "A",
    "title": "A",
    "truncated": {
      "dag": false,
      "task": false
    },
    "type": "sessions.activity"
  },
  "freshActivity": {
    "revision": 1790443356248,
    "data": {
      "at": "2026-09-26T00:00:05Z",
      "lastAssistantLine": "current binding activity",
      "nodeId": "node-new",
      "runId": "run-new",
      "taskId": "attached-task-0"
    },
    "name": "omo.dag.activity",
    "sessionId": "A",
    "type": "extensionEvent",
    "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3"
  },
  "freshAttachedFrames": [
    {
      "revision": 1790443356246,
      "data": {
        "agent_running_count": 2,
        "agent_total_count": 2,
        "parent_session_id": "durable-00000001-4f2a-9c31",
        "running_count": 2,
        "tasks": [
          {
            "created_at": "2026-09-26T00:00:00Z",
            "status": "running",
            "task_id": "attached-task-0",
            "updated_at": "2026-09-26T00:00:04Z"
          },
          {
            "created_at": "2026-09-26T00:00:00Z",
            "status": "running",
            "task_id": "attached-task-1",
            "updated_at": "2026-09-26T00:00:04Z"
          }
        ],
        "total_count": 2,
        "truncated_tasks": false
      },
      "name": "omo.task.updated",
      "sessionId": "A",
      "type": "extensionEvent",
      "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3"
    },
    {
      "revision": 1790443356247,
      "data": {
        "agent_running_count": 2,
        "agent_total_count": 2,
        "parent_session_id": "durable-00000001-4f2a-9c31",
        "run_running_count": 0,
        "run_total_count": 0,
        "running_count": 0,
        "runs": []
      },
      "name": "omo.dag.updated",
      "sessionId": "A",
      "type": "extensionEvent",
      "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3"
    },
    {
      "revision": 1790443356248,
      "data": {
        "at": "2026-09-26T00:00:05Z",
        "lastAssistantLine": "current binding activity",
        "nodeId": "node-new",
        "runId": "run-new",
        "taskId": "attached-task-0"
      },
      "name": "omo.dag.activity",
      "sessionId": "A",
      "type": "extensionEvent",
      "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3"
    }
  ],
  "freshDag": {
    "revision": 1790443356247,
    "data": {
      "agent_running_count": 2,
      "agent_total_count": 2,
      "parent_session_id": "durable-00000001-4f2a-9c31",
      "run_running_count": 0,
      "run_total_count": 0,
      "running_count": 0,
      "runs": []
    },
    "name": "omo.dag.updated",
    "sessionId": "A",
    "type": "extensionEvent",
    "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3"
  },
  "freshREST": {
    "instanceId": "GCWCAJBPNIAGWFAYWMPHOZXDTF",
    "sessions": [
      {
        "active": false,
        "dag_done": 0,
        "dag_total": 0,
        "done": 0,
        "durableSessionId": "Y",
        "id": "A",
        "last_activity_ms": 1790443356232,
        "running": {
          "agents": 2,
          "dag": 0,
          "tasks": 2
        },
        "title": "A",
        "truncated": {
          "dag": false,
          "task": false
        }
      }
    ]
  },
  "freshTask": {
    "revision": 1790443356246,
    "data": {
      "agent_running_count": 2,
      "agent_total_count": 2,
      "parent_session_id": "durable-00000001-4f2a-9c31",
      "running_count": 2,
      "tasks": [
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-0",
          "updated_at": "2026-09-26T00:00:04Z"
        },
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-1",
          "updated_at": "2026-09-26T00:00:04Z"
        }
      ],
      "total_count": 2,
      "truncated_tasks": false
    },
    "name": "omo.task.updated",
    "sessionId": "A",
    "type": "extensionEvent",
    "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3"
  },
  "hello": {
    "instanceId": "GCWCAJBPNIAGWFAYWMPHOZXDTF",
    "serverVersion": "1.2.3",
    "type": "hello",
    "version": 3
  },
  "movedOverview": [
    {
      "active": false,
      "dag_done": 0,
      "dag_total": 0,
      "done": 0,
      "durableSessionId": "durable-00000001-4f2a-9c31",
      "id": "A",
      "last_activity_ms": 1790443356221,
      "overflow": false,
      "running": {
        "agents": 7,
        "dag": 0,
        "tasks": 7
      },
      "sessionId": "A",
      "title": "A",
      "truncated": {
        "dag": false,
        "task": false
      },
      "type": "sessions.activity",
      "bindingId": "OVUU2YICWR3RJURPNOZ6C3D4QS"
    },
    {
      "active": false,
      "dag_done": 0,
      "dag_total": 0,
      "done": 0,
      "durableSessionId": "Y",
      "id": "A",
      "last_activity_ms": 1790443356232,
      "overflow": false,
      "running": {
        "agents": 2,
        "dag": 0,
        "tasks": 2
      },
      "sessionId": "A",
      "title": "A",
      "truncated": {
        "dag": false,
        "task": false
      },
      "type": "sessions.activity",
      "bindingId": "binding-Y"
    }
  ],
  "newReady": {
    "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3",
    "piSessionId": "durable-00000001-4f2a-9c31",
    "resumed": true,
    "sessionId": "A",
    "type": "ready"
  },
  "oldREST": {
    "instanceId": "GCWCAJBPNIAGWFAYWMPHOZXDTF",
    "sessions": [
      {
        "active": false,
        "dag_done": 0,
        "dag_total": 0,
        "done": 0,
        "durableSessionId": "durable-00000001-4f2a-9c31",
        "id": "A",
        "last_activity_ms": 1790443356221,
        "running": {
          "agents": 7,
          "dag": 0,
          "tasks": 7
        },
        "title": "A",
        "truncated": {
          "dag": false,
          "task": false
        }
      }
    ]
  },
  "ready": {
    "bindingId": "OVUU2YICWR3RJURPNOZ6C3D4QS",
    "piSessionId": "durable-00000001-4f2a-9c31",
    "resumed": false,
    "sessionId": "A",
    "type": "ready"
  },
  "returned": {
    "active": false,
    "dag_done": 0,
    "dag_total": 0,
    "done": 0,
    "durableSessionId": "durable-00000001-4f2a-9c31",
    "id": "A",
    "last_activity_ms": 1790443356245,
    "overflow": false,
    "running": {
      "agents": 2,
      "dag": 0,
      "tasks": 2
    },
    "sessionId": "A",
    "title": "A",
    "truncated": {
      "dag": false,
      "task": false
    },
    "type": "sessions.activity"
  },
  "returnedOverview": [
    {
      "active": false,
      "dag_done": 0,
      "dag_total": 0,
      "done": 0,
      "durableSessionId": "durable-00000001-4f2a-9c31",
      "id": "A",
      "last_activity_ms": 1790443356243,
      "overflow": false,
      "running": {
        "agents": 0,
        "dag": 0,
        "tasks": 0
      },
      "sessionId": "A",
      "title": "A",
      "truncated": {
        "dag": false,
        "task": false
      },
      "type": "sessions.activity",
      "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3"
    },
    {
      "active": false,
      "dag_done": 0,
      "dag_total": 0,
      "done": 0,
      "durableSessionId": "durable-00000001-4f2a-9c31",
      "id": "A",
      "last_activity_ms": 1790443356245,
      "overflow": false,
      "running": {
        "agents": 2,
        "dag": 0,
        "tasks": 2
      },
      "sessionId": "A",
      "title": "A",
      "truncated": {
        "dag": false,
        "task": false
      },
      "type": "sessions.activity",
      "bindingId": "UAK7A2XMOLU4SFXEQN3MTC3KW3"
    }
  ],
  "task": {
    "revision": 1790443356222,
    "data": {
      "agent_running_count": 7,
      "agent_total_count": 7,
      "parent_session_id": "durable-00000001-4f2a-9c31",
      "running_count": 7,
      "tasks": [
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-0",
          "updated_at": "2026-09-26T00:00:01Z"
        },
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-1",
          "updated_at": "2026-09-26T00:00:01Z"
        },
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-2",
          "updated_at": "2026-09-26T00:00:01Z"
        },
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-3",
          "updated_at": "2026-09-26T00:00:01Z"
        },
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-4",
          "updated_at": "2026-09-26T00:00:01Z"
        },
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-5",
          "updated_at": "2026-09-26T00:00:01Z"
        },
        {
          "created_at": "2026-09-26T00:00:00Z",
          "status": "running",
          "task_id": "attached-task-6",
          "updated_at": "2026-09-26T00:00:01Z"
        }
      ],
      "total_count": 7,
      "truncated_tasks": false
    },
    "name": "omo.task.updated",
    "sessionId": "A",
    "type": "extensionEvent",
    "bindingId": "OVUU2YICWR3RJURPNOZ6C3D4QS"
  }
} as const;

