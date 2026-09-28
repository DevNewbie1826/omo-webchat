import { describe, expect, it } from "vitest";
import {
  askUserAnswerRows,
  askUserHeadersFor,
  parseAskUserAnswerFrame,
} from "./askUserAnswer";

describe("parseAskUserAnswerFrame", () => {
  it("parses the omo answer frame into requestId and verbatim body", () => {
    expect(parseAskUserAnswerFrame("[Answer to question toolu_x]\nQA1: A")).toEqual({
      requestId: "toolu_x",
      body: "QA1: A",
    });
  });

  it("accepts a CRLF header line and a multi-line body", () => {
    expect(parseAskUserAnswerFrame("[Answer to question req-1]\r\nline1\nline2")).toEqual({
      requestId: "req-1",
      body: "line1\nline2",
    });
  });

  it("rejects non-frame text, an empty body line, and bracketed requestIds", () => {
    expect(parseAskUserAnswerFrame("Answer to question toolu_x\nQA1: A")).toBeUndefined();
    expect(parseAskUserAnswerFrame("[Answer to question toolu_x]")).toBeUndefined();
    expect(parseAskUserAnswerFrame("[Answer to question a]b]\nbody")).toBeUndefined();
    expect(parseAskUserAnswerFrame("")).toBeUndefined();
  });
});

describe("askUserAnswerRows", () => {
  const headers = ["QA1", "QA2"];

  it("maps answered body lines to one row per header", () => {
    const frame = { requestId: "toolu_x", body: "QA1: A\nQA2: B" };
    expect(askUserAnswerRows(frame, headers)).toEqual([
      { header: "QA1", value: "A" },
      { header: "QA2", value: "B" },
    ]);
  });

  it("renders a comment-submitted body as a JSON-quoted comment row on the first header", () => {
    const frame = { requestId: "toolu_x", body: "The user responded: looks fine" };
    expect(askUserAnswerRows(frame, headers)).toEqual([
      { header: "QA1", value: '"looks fine"' },
    ]);
  });

  it("keeps answer rows and adds one no-answer row per unanswered header", () => {
    const frame = { requestId: "toolu_x", body: "QA1: A\nUnanswered: QA2" };
    expect(askUserAnswerRows(frame, headers)).toEqual([
      { header: "QA1", value: "A" },
      { header: "QA2" },
    ]);
  });

  it("collapses a timed_out body to one no-answer row per header", () => {
    const frame = {
      requestId: "toolu_x",
      body: "The user did not answer within 30 minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)",
    };
    expect(askUserAnswerRows(frame, headers)).toEqual([{ header: "QA1" }, { header: "QA2" }]);
  });

  it("collapses dismissed, orphaned and unavailable bodies the same way", () => {
    for (const body of [
      "The user dismissed the question.",
      "The pending question could not be resumed after a restart; continue on best judgment.",
      "This session has no user attached (subagent or headless); decide on best judgment.",
    ]) {
      expect(askUserAnswerRows({ requestId: "toolu_x", body }, headers)).toEqual([
        { header: "QA1" },
        { header: "QA2" },
      ]);
    }
  });

  it("falls back to the requestId when no headers are known", () => {
    const frame = { requestId: "toolu_x", body: "The user dismissed the question." };
    expect(askUserAnswerRows(frame, [])).toEqual([{ header: "toolu_x" }]);
  });

  it("falls back to no-answer rows when the body has no parseable lines", () => {
    const frame = { requestId: "toolu_x", body: "no separator anywhere" };
    expect(askUserAnswerRows(frame, headers)).toEqual([{ header: "QA1" }, { header: "QA2" }]);
  });
});

describe("askUserHeadersFor", () => {
  const messages = [
    {
      blocks: [
        {
          kind: "toolCall",
          id: "toolu_x",
          name: "ask_user_question",
          arguments: { questions: [{ id: "q1", header: "QA1" }, { id: "q2", header: "QA2" }] },
        },
      ],
    },
  ];

  it("reads headers from the matching ask_user_question call args", () => {
    expect(askUserHeadersFor("toolu_x", messages)).toEqual(["QA1", "QA2"]);
  });

  it("reads headers from a request_user_input call and from folded tool blocks", () => {
    const folded = [
      {
        blocks: [
          {
            kind: "tool",
            id: "toolu_y",
            name: "request_user_input",
            arguments: { questions: [{ id: "q1", header: "H1" }] },
          },
        ],
      },
    ];
    expect(askUserHeadersFor("toolu_y", folded)).toEqual(["H1"]);
  });

  it("returns empty for unknown ids, other tools, and headerless args", () => {
    expect(askUserHeadersFor("toolu_z", messages)).toEqual([]);
    expect(
      askUserHeadersFor("toolu_x", [
        { blocks: [{ kind: "toolCall", id: "toolu_x", name: "bash", arguments: { command: "ls" } }] },
      ]),
    ).toEqual([]);
    expect(
      askUserHeadersFor("toolu_x", [
        { blocks: [{ kind: "toolCall", id: "toolu_x", name: "ask_user_question", arguments: {} }] },
      ]),
    ).toEqual([]);
  });
});
