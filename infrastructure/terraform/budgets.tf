# ============================================================================
# AWS BILLING PROTECTION
# Budget alerts + ML-based cost anomaly detection.
# Both are global AWS services managed in us-east-1.
# ============================================================================

# ----------------------------------------------------------------------------
# Monthly cost budget with 3 notification thresholds
#
# Limit: $100/month (expected baseline ~$15-20 after CloudFront)
# Alerts:
#   - $40 actual  (40% of budget) → early warning, 2x baseline
#   - $75 actual  (75% of budget) → serious, something is wrong
#   - $100 forecasted → catches runaway spend before month ends
# ----------------------------------------------------------------------------

resource "aws_budgets_budget" "monthly_cost" {
  provider = aws.us_east_1

  name         = "${var.project_name}-monthly-cost"
  budget_type  = "COST"
  limit_amount = "100"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  # Actual spend > $40
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 40
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  # Actual spend > $75
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 75
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  # Forecasted to exceed $100 by month end
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alert_email]
  }
}

# ----------------------------------------------------------------------------
# Cost Anomaly Detection (free, ML-based)
#
# Monitors spend per service and alerts on unusual patterns.
# Catches things budgets miss — a specific service doubling in cost,
# unexpected new services, data transfer spikes, etc.
# ----------------------------------------------------------------------------

resource "aws_ce_anomaly_monitor" "services" {
  provider = aws.us_east_1

  name              = "${var.project_name}-services-monitor"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "alerts" {
  provider = aws.us_east_1

  name      = "${var.project_name}-cost-anomaly-alerts"
  frequency = "DAILY"

  monitor_arn_list = [
    aws_ce_anomaly_monitor.services.arn,
  ]

  subscriber {
    type    = "EMAIL"
    address = var.alert_email
  }

  # Only alert on anomalies with >= $10 absolute impact (reduces noise)
  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      values        = ["10"]
      match_options = ["GREATER_THAN_OR_EQUAL"]
    }
  }
}
