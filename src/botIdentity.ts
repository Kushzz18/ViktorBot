let slackBotUserId: string | undefined;

export function setSlackBotUserId(userId?: string) {
  const normalized = userId?.trim();
  slackBotUserId = normalized || undefined;
}

export function hasViktorMention(text: string): boolean {
  if (/\bviktor\b/i.test(text)) return true;
  return Boolean(slackBotUserId && text.includes(`<@${slackBotUserId}>`));
}
