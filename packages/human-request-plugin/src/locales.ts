/** UI labels follow the Harness locale; decisions use stable protocol values. */
export const en = {
  reviewTitle: 'Review', reviewInstruction: 'Choose Approve or Request changes, then submit your decision.',
  title: 'Human requests', status: 'Request status', pending: 'Pending', answered: 'Answered',
  empty: 'No requests', response: 'Human response', approve: 'Approve', adjust: 'Request changes',
  submit: 'Submit response', approved: 'Approved', changesRequested: 'Changes requested', confirmDecision: 'Select a decision to complete this review. Your earlier response is preserved.',
}
export type RequestTranslate = (key: keyof typeof en) => string
export const zh: Record<keyof typeof en, string> = {
  reviewTitle: '评审', reviewInstruction: '选择同意或请调整，然后提交决定。',
  title: '人类需求', status: '需求状态', pending: '待处理', answered: '已答复',
  empty: '暂无需求', response: '人工答复', approve: '同意', adjust: '请调整',
  submit: '提交答复', approved: '已同意', changesRequested: '已要求调整', confirmDecision: '请选择决定以完成本次评审。之前的答复会保留。',
}
