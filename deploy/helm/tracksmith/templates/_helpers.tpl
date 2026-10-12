{{- define "tracksmith.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "tracksmith.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "tracksmith.selector" -}}
app.kubernetes.io/name: {{ .root.Chart.Name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "tracksmith.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "tracksmith.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{ default (include "tracksmith.fullname" .) .Values.serviceAccount.name }}
{{- else -}}
{{ default "default" .Values.serviceAccount.name }}
{{- end -}}
{{- end -}}

{{- define "tracksmith.databaseSecret" -}}
{{- if .Values.database.existingSecret -}}
{{ .Values.database.existingSecret }}
{{- else -}}
{{ include "tracksmith.fullname" . }}-database
{{- end -}}
{{- end -}}

{{/* Settings shared by every container that runs the image. */}}
{{- define "tracksmith.env" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "tracksmith.databaseSecret" . }}
      key: {{ .Values.database.existingSecretKey }}
- name: PUBLIC_URL
  value: {{ .Values.publicUrl | quote }}
- name: LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
- name: TRACKSMITH_VERSION
  value: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
- name: METRICS_PORT
  value: {{ .Values.metrics.port | quote }}
{{- if .Values.setupToken.existingSecret }}
- name: TRACKSMITH_SETUP_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.setupToken.existingSecret }}
      key: {{ .Values.setupToken.existingSecretKey }}
{{- end }}
{{- if eq .Values.storage.type "s3" }}
- name: TRACKSMITH_STORAGE
  value: s3
- name: S3_ENDPOINT
  value: {{ .Values.storage.s3.endpoint | quote }}
- name: S3_BUCKET
  value: {{ required "storage.s3.bucket is required when storage.type is s3" .Values.storage.s3.bucket | quote }}
- name: S3_REGION
  value: {{ .Values.storage.s3.region | quote }}
- name: S3_FORCE_PATH_STYLE
  value: {{ .Values.storage.s3.forcePathStyle | quote }}
{{- if .Values.storage.s3.existingSecret }}
- name: S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef: { name: {{ .Values.storage.s3.existingSecret }}, key: S3_ACCESS_KEY_ID }
- name: S3_SECRET_ACCESS_KEY
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
{{- define "tracksmith.validate" -}}
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
