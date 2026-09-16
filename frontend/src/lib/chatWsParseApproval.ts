import type { ApprovalFrame, Question, QuestionOption } from "./contract/types_gen";
import { mapRecords, optBoolean, optNumber, optString, optStringArray, reqString } from "./chatWsParseFields";

/** Both question surfaces use one-based positional keys for omitted ids. */
export function questionKey(question: Question | undefined, index: number): string {
  return question?.id ?? `q${index + 1}`;
}

function parseQuestionOption(record: Record<string, unknown>): QuestionOption | null {
  const label = optString(record, "label");
  const description = optString(record, "description");
  if (label === null || description === null) return null;
  return {
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
  };
}

function parseQuestion(record: Record<string, unknown>): Question | null {
  const id = optString(record, "id");
  const header = optString(record, "header");
  const question = optString(record, "question");
  const multiSelect = optBoolean(record, "multiSelect");
  const options = record["options"] === undefined ? undefined : mapRecords(record["options"], parseQuestionOption);
  if (id === null || header === null || question === null || multiSelect === null || options === null) return null;
  // Answers carry labels, not descriptions or option ids. Reject collisions
  // before either surface can turn distinct options into the same selection.
  if (options && new Set(options.map(option => option.label ?? "")).size !== options.length) return null;
  return {
    ...(id === undefined ? {} : { id }),
    ...(header === undefined ? {} : { header }),
    ...(question === undefined ? {} : { question }),
    ...(multiSelect === undefined ? {} : { multiSelect }),
    ...(options === undefined ? {} : { options }),
  };
}

export function parseApprovalFrame(msg: Record<string, unknown>, sessionId: string): ApprovalFrame | null {
  const id = reqString(msg, "id");
  const method = msg["method"];
  if (id === null) return null;
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor" && method !== "question") return null;
  const title = optString(msg, "title");
  const message = optString(msg, "message");
  const options = optStringArray(msg, "options");
  const prefill = optString(msg, "prefill");
  const placeholder = optString(msg, "placeholder");
  const deadlineAtMs = optNumber(msg, "deadlineAtMs");
  const remainingMs = optNumber(msg, "remainingMs");
  const questions = msg["questions"] === undefined ? undefined : mapRecords(msg["questions"], parseQuestion);
  // A question without controls must use the cancellable unsupported-request fallback.
  if (method === "question" && (questions?.length ?? 0) === 0) return null;
  // Ambiguous keys would overwrite a prior answer; retain the cancellable fallback.
  if (questions && new Set(questions.map(questionKey)).size !== questions.length) return null;
  const nonBlocking = optBoolean(msg, "nonBlocking");
  if (title === null || message === null || options === null || prefill === null || placeholder === null || deadlineAtMs === null || remainingMs === null || questions === null || nonBlocking === null) return null;
  return {
    type: "approval", sessionId, id, method,
    ...(title !== undefined ? { title } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(options !== undefined ? { options } : {}),
    ...(prefill !== undefined ? { prefill } : {}),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(deadlineAtMs !== undefined ? { deadlineAtMs } : {}),
    ...(remainingMs !== undefined ? { remainingMs } : {}),
    ...(questions !== undefined ? { questions } : {}),
    ...(nonBlocking !== undefined ? { nonBlocking } : {}),
  };
}
