/** Keep opaque LINE identifiers out of user-facing labels. */
export function displayChatName(name: string | null | undefined, chatId: string, isGroup: boolean): string {
  const value = name?.trim()
  if (value && value !== chatId) return value
  return isGroup ? '未命名群組' : 'LINE 聯絡人'
}
