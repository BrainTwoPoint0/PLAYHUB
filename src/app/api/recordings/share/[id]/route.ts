// Shareable recording link - redirects to platform page for access control
import { NextResponse } from 'next/server'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { origin } = new URL(request.url)

  // Redirect to platform page where access control is handled
  return NextResponse.redirect(`${origin}/recordings/${id}`)
}
