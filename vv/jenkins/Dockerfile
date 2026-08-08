# Jenkins con lo que el pipeline de este proyecto necesita dentro del propio contenedor:
# Node 20 (el monorepo es TypeScript) y el escáner de Sonar. Sin agentes externos: un solo
# contenedor que se basta, que es lo que se puede enseñar funcionando en una feria.
FROM jenkins/jenkins:lts-jdk21

USER root

# Node 20 desde NodeSource. `--no-install-recommends` mantiene la imagen razonable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Escáner de Sonar. Se instala aquí y no como plugin de Jenkins para que el pipeline pueda
# ejecutarse igual a mano (`sonar-scanner`) cuando se quiera reproducir un análisis sin CI.
ARG SONAR_SCANNER_VERSION=6.2.1.4610
RUN curl -fsSL -o /tmp/scanner.zip \
      "https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SONAR_SCANNER_VERSION}-linux-x64.zip" \
 && unzip -q /tmp/scanner.zip -d /opt \
 && mv "/opt/sonar-scanner-${SONAR_SCANNER_VERSION}-linux-x64" /opt/sonar-scanner \
 && rm /tmp/scanner.zip
ENV PATH="/opt/sonar-scanner/bin:${PATH}"

# Los plugins que usa el Jenkinsfile: pipeline, git y el publicador de resultados JUnit/HTML.
COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

# Usuario admin y el job ya creado: al levantar el contenedor hay pipeline, no un asistente.
COPY casc.yaml /var/jenkins_home/casc.yaml
ENV CASC_JENKINS_CONFIG=/var/jenkins_home/casc.yaml

USER jenkins
