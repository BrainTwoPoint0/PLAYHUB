import { LumaSpin } from '@braintwopoint0/playback-commons/ui'

export default function Loading() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-[#0a100d] z-50">
      <LumaSpin />
    </div>
  )
}
