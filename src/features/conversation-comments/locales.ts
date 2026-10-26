export const zh = {
  add: '添加批注', edit: '编辑批注', note: '修改意见', placeholder: '希望这段内容如何修改或补充？',
  save: '保存批注', cancel: '取消', remove: '删除批注', close: '关闭',
  count: '{count} 条注释', title: '会话批注与修改建议',
  send: '提交批注', insert: '加入输入框',
  hint: '保存批注后会自动放入输入框，发送消息时与文字、引用和附件一起提交。点击输入框内的批注可查看或修改。',
  pending: '批注已提交，等待会话确认。请勿重复发送。',
  inserted: '批注已加入输入框。发送或从输入框移除这批批注后，可继续修改批注。',
  changed: '输入框状态已变化，请稍后重试。', unavailable: '当前会话暂不可提交，请稍后重试。',
  marker: '批注 {number}：{note}', receipt: '会话批注编号',
  newQuestion: '新会话提问', questionFailed: '暂时无法创建新会话，请重试。',
}
export type ConversationCommentKey = keyof typeof zh
export const en: Record<ConversationCommentKey, string> = {
  add: 'Add comment', edit: 'Edit comment', note: 'Requested change', placeholder: 'How should this passage change?',
  save: 'Save comment', cancel: 'Cancel', remove: 'Delete comment', close: 'Close',
  count: '{count} comments', title: 'Conversation comments and suggestions',
  send: 'Submit comments', insert: 'Add to composer',
  hint: 'Saved comments appear in the composer and are sent with your text, references and attachments. Click the comment chip to review or edit them.',
  pending: 'Comments submitted; waiting for conversation confirmation. Do not send again.',
  inserted: 'Comments added to the composer. Send or remove this batch from the composer before editing comments again.',
  changed: 'The composer changed. Please try again.', unavailable: 'This conversation cannot accept comments right now.',
  marker: 'Comment {number}: {note}', receipt: 'Conversation comment submission',
  newQuestion: 'Ask in new chat', questionFailed: 'Could not create a new conversation. Please try again.',
}
