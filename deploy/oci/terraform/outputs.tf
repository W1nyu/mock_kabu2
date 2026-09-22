output "public_ip" {
  value = oci_core_instance.app.public_ip
}

output "ssh" {
  value = "ssh ubuntu@${oci_core_instance.app.public_ip}"
}

output "next_steps" {
  value = <<-EOT
    1. 도메인을 쓰면 A 레코드를 ${oci_core_instance.app.public_ip} 로 가리킨다.
    2. ssh ubuntu@${oci_core_instance.app.public_ip} 후 /opt/mock-kabu2/deploy/oci/scripts/bootstrap.sh 를 실행한다
       (cloud-init이 Docker 설치와 clone까지 끝내 두었다. 로그: /var/log/cloud-init-output.log).
  EOT
}
