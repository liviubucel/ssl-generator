// Minimal Resend API email sender for error notifications
export async function sendErrorEmail({ subject, text }: { subject: string, text: string }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'noreply@zebrabyte.com',
        to: 'zebrabyte@proton.me',
        subject,
        text,
      }),
    });
  } catch (e) {
    // fail silently
  }
}
