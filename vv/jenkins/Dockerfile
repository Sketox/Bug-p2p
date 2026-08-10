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

# El repo llega montado desde el host, así que sus archivos son de otro usuario que el `jenkins`
# del contenedor. Git se niega a trabajar con un repositorio ajeno ("detected dubious ownership")
# porque la configuración de un repo puede ejecutar comandos, y un repo de otro usuario es código
# de otro usuario. Aquí ese "otro" es quien está desarrollando —el mismo que levanta el
# laboratorio— y el montaje es de solo lectura, así que se declara la excepción para esa ruta.
#
# `--system` (que escribe en `/etc/gitconfig`) y no `--global`, por la misma razón por la que
# `casc.yaml` no vive en `/var/jenkins_home`: `--global` escribiría en `$HOME`, que **es el
# volumen**, y en un laboratorio ya creado no llegaría nunca. Cuesta un `USER root` y ahorra la
# tarde de no entender por qué reconstruir la imagen no cambia nada.
RUN git config --system --add safe.directory /repo-src \
 && git config --system --add safe.directory /repo-src/.git

# Los plugins que usa el Jenkinsfile: pipeline, git y el publicador de resultados JUnit/HTML.
COPY plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

# Usuario admin y el job ya creado: al levantar el contenedor hay pipeline, no un asistente.
#
# Va a `/usr/share/jenkins/ref/` y NO a `/var/jenkins_home/`, aunque lo segundo sea lo que se ve en
# media internet. `/var/jenkins_home` es un volumen: la primera vez Docker copia ahí lo que traiga
# la imagen, y a partir de entonces **el volumen manda**. Con la configuración dentro, corregir un
# error de `casc.yaml` y reconstruir no sirve de nada — el contenedor sigue leyendo la versión
# vieja del volumen, y la única salida es borrarlo. Fuera del volumen, cada arranque lee la
# configuración de la imagen, que es lo que uno espera al reconstruirla.
COPY casc.yaml /usr/share/jenkins/ref/casc.yaml
ENV CASC_JENKINS_CONFIG=/usr/share/jenkins/ref/casc.yaml

USER jenkins
