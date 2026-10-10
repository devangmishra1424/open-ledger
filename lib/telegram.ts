/**
 * Sends a notification to a reviewer via Telegram bot, including inline buttons
 * to approve or reject the invoice directly from the chat.
 */
export async function notifyReviewer(reviewerName: string, invoiceId: string, invoiceSummary: string, approveUrl: string, rejectUrl: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID; // Hardcoded for demo, or fetched from DB
  
  if (!token || !chatId) {
    console.warn("TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set, skipping Telegram notification.");
    return;
  }
  
  const text = `🚨 *Invoice Review Required*\n\n${invoiceSummary}\n\nInvoice ID: \`${invoiceId}\`\nAssigned to: ${reviewerName}`;
  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Approve", url: approveUrl },
        { text: "❌ Reject", url: rejectUrl }
      ]
    ]
  };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        reply_markup: replyMarkup
      })
    });
    if (!res.ok) {
      console.error("Failed to send Telegram notification:", await res.text());
    }
  } catch (e) {
    console.error("Error sending Telegram notification:", e);
  }
}
