variable "tenancy_ocid" { type = string }
variable "user_ocid" { type = string }
variable "fingerprint" { type = string }
variable "private_key_path" { type = string }
variable "compartment_ocid" { type = string }
variable "region" {
  type    = string
  default = "ap-chuncheon-1"
}

variable "name" {
  type    = string
  default = "mock-kabu2"
}

variable "availability_domain_index" {
  description = "A1 용량이 없는 AD를 피해 0/1/2로 바꿔 가며 재시도한다 (서울/춘천은 AD 1개)."
  type        = number
  default     = 0
}

# Always Free 상한: A1 합계 4 OCPU / 24GB. 용량이 부족하면 2 / 12로 낮춰 잡은 뒤 나중에 늘려도 된다.
variable "ocpus" {
  type    = number
  default = 4
}
variable "memory_gb" {
  type    = number
  default = 24
}
variable "boot_volume_gb" {
  description = "Always Free 블록 스토리지 합계 200GB 안에서. DB·백업·이미지에 100GB면 넉넉하다."
  type        = number
  default     = 100
}

variable "ssh_public_key" {
  type = string
}
variable "ssh_allowed_cidr" {
  description = "SSH를 허용할 CIDR. 가능하면 본인 IP/32."
  type        = string
  default     = "0.0.0.0/0"
}

variable "repo_url" {
  description = "cloud-init이 clone할 저장소 (공개 저장소 또는 deploy key 설정 후)."
  type        = string
}
variable "repo_ref" {
  type    = string
  default = "main"
}
variable "app_domain" {
  description = "Caddy가 HTTPS를 받을 도메인. 비우면 IP + HTTP 구성(compose.oci.yml)을 쓴다."
  type        = string
  default     = ""
}
