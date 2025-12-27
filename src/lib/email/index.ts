import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM_EMAIL = 'PLAYHUB <admin@playbacksports.ai>'
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://playhub.playbacksports.ai'

interface SendEmailResult {
  success: boolean
  error?: string
}

/**
 * Send venue admin invitation email
 */
export async function sendAdminInviteEmail(params: {
  toEmail: string
  venueName: string
  inviterName?: string
}): Promise<SendEmailResult> {
  const { toEmail, venueName, inviterName } = params

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `You've been invited to manage ${venueName} on PLAYHUB`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0a100d; color: #d6d5c9; padding: 40px 20px; margin: 0;">
          <div style="max-width: 500px; margin: 0 auto;">
            <h1 style="color: #d6d5c9; font-size: 24px; margin-bottom: 24px;">PLAYHUB</h1>

            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
              ${inviterName ? `${inviterName} has invited you` : "You've been invited"} to manage <strong>${venueName}</strong> on PLAYHUB.
            </p>

            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
              As a venue admin, you'll be able to schedule recordings, manage access, and invite other admins.
            </p>

            <a href="${APP_URL}/auth/register"
               style="display: inline-block; background-color: #d6d5c9; color: #0a100d; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
              Create your account
            </a>

            <p style="font-size: 14px; color: #b9baa3; margin-top: 32px;">
              Already have an account? <a href="${APP_URL}/auth/login" style="color: #d6d5c9;">Sign in here</a>
            </p>

            <hr style="border: none; border-top: 1px solid #333; margin: 32px 0;">

            <p style="font-size: 12px; color: #b9baa3;">
              This email was sent by PLAYHUB. If you didn't expect this invitation, you can ignore this email.
            </p>
          </div>
        </body>
        </html>
      `,
    })

    if (error) {
      console.error('Failed to send admin invite email:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    console.error('Email send error:', err)
    return { success: false, error: 'Failed to send email' }
  }
}

/**
 * Send recording access invitation email
 */
export async function sendRecordingAccessEmail(params: {
  toEmail: string
  recordingTitle: string
  venueName?: string
  inviterName?: string
  shareUrl?: string
}): Promise<SendEmailResult> {
  const { toEmail, recordingTitle, venueName, inviterName, shareUrl } = params

  const actionUrl = shareUrl || `${APP_URL}/auth/register`
  const actionText = shareUrl ? 'Watch recording' : 'Create your account'

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `You've been given access to "${recordingTitle}" on PLAYHUB`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0a100d; color: #d6d5c9; padding: 40px 20px; margin: 0;">
          <div style="max-width: 500px; margin: 0 auto;">
            <h1 style="color: #d6d5c9; font-size: 24px; margin-bottom: 24px;">PLAYHUB</h1>

            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
              ${inviterName ? `${inviterName} has shared` : "You've been given access to"} a recording with you:
            </p>

            <div style="background-color: #1a1f1c; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
              <p style="font-size: 18px; font-weight: 500; margin: 0 0 4px 0;">${recordingTitle}</p>
              ${venueName ? `<p style="font-size: 14px; color: #b9baa3; margin: 0;">${venueName}</p>` : ''}
            </div>

            <a href="${actionUrl}"
               style="display: inline-block; background-color: #d6d5c9; color: #0a100d; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
              ${actionText}
            </a>

            ${!shareUrl ? `
            <p style="font-size: 14px; color: #b9baa3; margin-top: 32px;">
              Already have an account? <a href="${APP_URL}/auth/login" style="color: #d6d5c9;">Sign in here</a> to view your recordings.
            </p>
            ` : ''}

            <hr style="border: none; border-top: 1px solid #333; margin: 32px 0;">

            <p style="font-size: 12px; color: #b9baa3;">
              This email was sent by PLAYHUB. If you didn't expect this, you can ignore this email.
            </p>
          </div>
        </body>
        </html>
      `,
    })

    if (error) {
      console.error('Failed to send recording access email:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    console.error('Email send error:', err)
    return { success: false, error: 'Failed to send email' }
  }
}

/**
 * Send email when a recording is assigned to an existing user's account
 */
export async function sendRecordingAssignedEmail(params: {
  toEmail: string
  recordingTitle: string
  matchDate?: string
  venueName?: string
  assignedBy?: string
}): Promise<SendEmailResult> {
  const { toEmail, recordingTitle, matchDate, venueName, assignedBy } = params

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `New recording added to your library: "${recordingTitle}"`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0a100d; color: #d6d5c9; padding: 40px 20px; margin: 0;">
          <div style="max-width: 500px; margin: 0 auto;">
            <h1 style="color: #d6d5c9; font-size: 24px; margin-bottom: 24px;">PLAYHUB</h1>

            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
              ${assignedBy ? `${assignedBy} has added` : 'A new recording has been added to'} your library:
            </p>

            <div style="background-color: #1a1f1c; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
              <p style="font-size: 18px; font-weight: 500; margin: 0 0 4px 0;">${recordingTitle}</p>
              ${venueName ? `<p style="font-size: 14px; color: #b9baa3; margin: 0;">${venueName}</p>` : ''}
              ${matchDate ? `<p style="font-size: 14px; color: #b9baa3; margin: 4px 0 0 0;">${matchDate}</p>` : ''}
            </div>

            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 24px;">
              You'll receive another email when the recording is ready to watch.
            </p>

            <a href="${APP_URL}/recordings"
               style="display: inline-block; background-color: #d6d5c9; color: #0a100d; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
              View your library
            </a>

            <hr style="border: none; border-top: 1px solid #333; margin: 32px 0;">

            <p style="font-size: 12px; color: #b9baa3;">
              This email was sent by PLAYHUB. If you didn't expect this, you can ignore this email.
            </p>
          </div>
        </body>
        </html>
      `,
    })

    if (error) {
      console.error('Failed to send recording assigned email:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    console.error('Email send error:', err)
    return { success: false, error: 'Failed to send email' }
  }
}

/**
 * Send email when a recording is uploaded and ready to watch
 */
export async function sendRecordingReadyEmail(params: {
  toEmail: string
  recordingTitle: string
  matchDate?: string
  venueName?: string
  watchUrl?: string
}): Promise<SendEmailResult> {
  const { toEmail, recordingTitle, matchDate, venueName, watchUrl } = params

  const actionUrl = watchUrl || `${APP_URL}/recordings`

  try {
    const { error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: toEmail,
      subject: `Your recording is ready: "${recordingTitle}"`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0a100d; color: #d6d5c9; padding: 40px 20px; margin: 0;">
          <div style="max-width: 500px; margin: 0 auto;">
            <h1 style="color: #d6d5c9; font-size: 24px; margin-bottom: 24px;">PLAYHUB</h1>

            <p style="font-size: 16px; line-height: 1.6; margin-bottom: 16px;">
              Great news! Your recording is now ready to watch:
            </p>

            <div style="background-color: #1a1f1c; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
              <p style="font-size: 18px; font-weight: 500; margin: 0 0 4px 0;">${recordingTitle}</p>
              ${venueName ? `<p style="font-size: 14px; color: #b9baa3; margin: 0;">${venueName}</p>` : ''}
              ${matchDate ? `<p style="font-size: 14px; color: #b9baa3; margin: 4px 0 0 0;">${matchDate}</p>` : ''}
            </div>

            <a href="${actionUrl}"
               style="display: inline-block; background-color: #d6d5c9; color: #0a100d; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 500;">
              Watch now
            </a>

            <hr style="border: none; border-top: 1px solid #333; margin: 32px 0;">

            <p style="font-size: 12px; color: #b9baa3;">
              This email was sent by PLAYHUB. If you didn't expect this, you can ignore this email.
            </p>
          </div>
        </body>
        </html>
      `,
    })

    if (error) {
      console.error('Failed to send recording ready email:', error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (err) {
    console.error('Email send error:', err)
    return { success: false, error: 'Failed to send email' }
  }
}
