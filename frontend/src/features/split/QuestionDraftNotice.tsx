import { useLayoutEffect, useRef } from "react";
import { useT } from "../../i18n";
import { questionKey } from "../../lib/chatWsParseApproval";
import type { Question } from "../../lib/contract/types_gen";

export function QuestionDraftNotice({ answers, questions }: {
 readonly answers: ReadonlyMap<string, { readonly invalidated?: boolean }>;
 readonly questions: readonly Question[];
}) {
 const { t } = useT();
 const noticeRef = useRef<HTMLDivElement>(null);
 const affected = questions.flatMap((question, index) => {
  const key = questionKey(question, index);
  return answers.get(key)?.invalidated ? [{ key, name: question.header ?? question.question ?? t("approval.question.tab", { index: index + 1 }) }] : [];
 });
 const affectedKeys = JSON.stringify(affected.map(question => question.key));
 useLayoutEffect(() => {
  if (affectedKeys === "[]") return;
  // Reveal a new notice in the dock's own scrollport, never scroll the page
  // or move keyboard focus. It remains in normal flow so controls stay usable.
  const scrollport = noticeRef.current?.closest(".th-approval-dock-body, .th-approval-dock-summary");
  if (scrollport) scrollport.scrollTop = 0;
 }, [affectedKeys]);
 return <div ref={noticeRef} role="status" aria-atomic="true" className="th-question-draft-notice">
  {affected.map(question => <div key={question.key} data-question-key={question.key}>
   {t("approval.question.invalidated", { question: question.name })}
  </div>)}
 </div>;
}
