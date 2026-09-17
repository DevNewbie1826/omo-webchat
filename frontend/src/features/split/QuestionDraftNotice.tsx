import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import { questionKey } from "../../lib/chatWsParseApproval";
import type { Question } from "../../lib/contract/types_gen";

export type QuestionDraftAnswer = {
 readonly selected: readonly string[];
 readonly text: string;
 readonly textAnswered?: boolean;
 /** Explicit single-choice activation or inline Send, never draft presence. */
 readonly completed: boolean;
 readonly invalidated?: boolean;
};

/** Compare user intent, not differences in draft bookkeeping. */
export function lostQuestionAnswer(before: QuestionDraftAnswer, after?: QuestionDraftAnswer): boolean {
 return before.selected.some(label => !after?.selected.includes(label))
  || (before.text.trim() !== "" && before.text !== after?.text)
  || (before.textAnswered === true && after?.textAnswered !== true);
}

export type RemovedQuestionNotice = { readonly key: string; readonly name: string | undefined; readonly index: number };
export const RemovedQuestionNoticeContext = createContext<readonly RemovedQuestionNotice[]>([]);

export function QuestionDraftNotice({ answers, questions, removedQuestions }: {
 readonly answers: ReadonlyMap<string, { readonly invalidated?: boolean }>;
 readonly questions: readonly Question[];
 readonly removedQuestions?: readonly RemovedQuestionNotice[];
}) {
 const { t } = useT();
 const ownedNotices = useContext(RemovedQuestionNoticeContext);
 const removed = removedQuestions ?? ownedNotices;
 const noticeRef = useRef<HTMLDivElement>(null);
 const affected = questions.flatMap((question, index) => {
  const key = questionKey(question, index);
  return answers.get(key)?.invalidated && !removed.some(notice => notice.key === key) ? [{ key, name: question.header ?? question.question ?? t("approval.question.tab", { index: index + 1 }) }] : [];
 });
 const affectedKeys = JSON.stringify([...removed, ...affected].map(question => question.key));
 useLayoutEffect(() => {
  if (affectedKeys === "[]") return;
  // Reveal a new notice in the window body's own scrollport, never scroll the
  // page or move keyboard focus. It remains in normal flow so controls stay usable.
  const scrollport = noticeRef.current?.closest(".th-question-window-body");
  if (scrollport) scrollport.scrollTop = 0;
 }, [affectedKeys]);
 return <div ref={noticeRef} role="status" aria-atomic="true" className="th-question-draft-notice">
  {removed.map(question => <div key={question.key} data-question-key={question.key}>
   {t("approval.question.removed", { question: question.name ?? t("approval.question.tab", { index: question.index + 1 }) })}
  </div>)}
  {affected.map(question => <div key={question.key} data-question-key={question.key}>
   {t("approval.question.invalidated", { question: question.name })}
  </div>)}
 </div>;
}
