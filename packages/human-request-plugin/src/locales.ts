/** UI copy and editable reply templates follow the Harness locale.
 * Example: English approval inserts "Approved. Please continue." into the response.
 */
export const en = {
  title: 'Human requests', status: 'Request status', pending: 'Pending', answered: 'Answered',
  empty: 'No requests', response: 'Human response', approve: 'Approve', adjust: 'Request changes',
  submit: 'Submit response', approveMerge: 'Approved to merge these changes.',
  approveTest: 'Acceptance passed.', approveContinue: 'Approved. Please continue.', adjustReply: 'Please adjust:',
}
export type RequestTranslate = (key: keyof typeof en) => string
export const zh: Record<keyof typeof en, string> = {
  title: '人类需求', status: '需求状态', pending: '待处理', answered: '已答复',
  empty: '暂无需求', response: '人工答复', approve: '同意', adjust: '请调整',
  submit: '提交答复', approveMerge: '批准合入本次修改。', approveTest: '通过验收',
  approveContinue: '同意，请继续。', adjustReply: '请调整：',
}
