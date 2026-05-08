export type HealthErrorCode =
  | 'connection_failed'
  | 'timeout'
  | 'auth_failed'
  | 'misconfigured'
  | 'unknown'

export interface ServiceStatus {
  name: string
  status: 'healthy' | 'unhealthy'
  latencyMs: number
  error?: HealthErrorCode
  critical: boolean
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  // Seconds since this Lambda instance started — resets on every cold
  // start. Not a service-uptime metric; named so dashboards can't
  // misinterpret it as availability.
  instanceUptime: number
  services: ServiceStatus[]
}
