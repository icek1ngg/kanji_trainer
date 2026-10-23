/** Detailed feedback never includes the stored readings or changes grading. */
export default function AnswerFeedback({ item, mode }) {
  if (mode === 'compact' || item?.checkedAnswer !== item?.answer || typeof item?.result !== 'boolean') return null;
  return <p className="answer-feedback" role="status">{item.result
    ? 'Bạn đã nhập đủ tất cả âm Hán Việt.'
    : `Cần nhập đúng và đủ ${item.hanViet.length} âm Hán Việt; thứ tự không quan trọng.`}</p>;
}
