{{- define "taskmoor.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "taskmoor.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "taskmoor.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "taskmoor.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "taskmoor.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{ default (include "taskmoor.fullname" .) .Values.serviceAccount.name }}
{{- else -}}
{{ default "default" .Values.serviceAccount.name }}
{{- end -}}
{{- end -}}

{{- define "taskmoor.databaseSecret" -}}
{{- if .Values.database.existingSecret -}}
{{ .Values.database.existingSecret }}
{{- else -}}
{{ include "taskmoor.fullname" . }}-database
{{- end -}}
{{- end -}}

{{/* Settings shared by every container that runs the image. */}}
{{- define "taskmoor.env" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "taskmoor.databaseSecret" . }}
      key: {{ .Values.database.existingSecretKey }}
- name: PUBLIC_URL
  value: {{ .Values.publicUrl | quote }}
- name: LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
- name: METRICS_PORT
  value: {{ .Values.metrics.port | quote }}
- name: TASKMOOR_UPDATE_CHECK
  value: {{ if .Values.updateCheck.enabled }}"on"{{ else }}"off"{{ end }}
- name: TASKMOOR_UPDATE_COMMAND
  value: {{ printf "helm upgrade %s deploy/helm/taskmoor --reuse-values --set image.tag={version}" .Release.Name | quote }}
- name: TASKMOOR_PASSWORD_PEPPER
  valueFrom:
    secretKeyRef:
      name: {{ .Values.passwordPepper.existingSecret | default (printf "%s-password-pepper" (include "taskmoor.fullname" .)) }}
      key: {{ .Values.passwordPepper.existingSecretKey }}
{{- if .Values.trustedProxies }}
- name: TASKMOOR_TRUSTED_PROXIES
  value: {{ .Values.trustedProxies | quote }}
{{- end }}
{{- if .Values.setupToken.existingSecret }}
- name: TASKMOOR_SETUP_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.setupToken.existingSecret }}
      key: {{ .Values.setupToken.existingSecretKey }}
{{- end }}
{{- if eq .Values.storage.type "s3" }}
# Attachments in a bucket (M1-016, ADR-040); keys come from the Secret, never from values.
- name: TASKMOOR_STORAGE
  value: s3
- name: TASKMOOR_S3_ENDPOINT
  value: {{ .Values.storage.s3.endpoint | quote }}
- name: TASKMOOR_S3_BUCKET
  value: {{ required "storage.s3.bucket is required when storage.type is s3" .Values.storage.s3.bucket | quote }}
- name: TASKMOOR_S3_REGION
  value: {{ .Values.storage.s3.region | quote }}
- name: TASKMOOR_S3_FORCE_PATH_STYLE
  value: {{ .Values.storage.s3.forcePathStyle | quote }}
{{- if .Values.storage.s3.existingSecret }}
- name: TASKMOOR_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef: { name: {{ .Values.storage.s3.existingSecret }}, key: S3_ACCESS_KEY_ID }
- name: TASKMOOR_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef: { name: {{ .Values.storage.s3.existingSecret }}, key: S3_SECRET_ACCESS_KEY }
{{- end }}
{{- end }}
{{- if .Values.otel.endpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .Values.otel.endpoint | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ .Values.otel.serviceName | quote }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* Fails early on settings that cannot work together. */}}
{{- define "taskmoor.validate" -}}
{{- if and (not .Values.database.existingSecret) (not .Values.database.url) -}}
{{- fail "Set database.existingSecret (recommended) or database.url" -}}
{{- end -}}
{{- $replicas := .Values.app.replicas | int -}}
{{- if .Values.app.autoscaling.enabled -}}{{- $replicas = .Values.app.autoscaling.maxReplicas | int -}}{{- end -}}
{{- if and (eq .Values.storage.type "local") (gt $replicas 1) (eq .Values.storage.local.accessMode "ReadWriteOnce") -}}
{{- fail "storage.type local with a ReadWriteOnce volume allows one app pod: use storage.type s3, storage.local.accessMode ReadWriteMany, or app.replicas 1" -}}
{{- end -}}
{{- if not (has .Values.storage.type (list "local" "s3")) -}}
{{- fail "storage.type must be local or s3" -}}
{{- end -}}
{{- end -}}
