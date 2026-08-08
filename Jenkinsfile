// CI de Bug. Se dispara con cada commit (el job sondea el repo cada minuto) y ejecuta, en este
// orden, lo que puede fallar más barato primero: tipos, pruebas, cobertura, build, calidad,
// seguridad y validación distribuida.
//
// Criterio de fallo: cualquier etapa roja tumba la construcción, EXCEPTO el análisis de Sonar
// cuando el laboratorio de calidad no está levantado — un servidor de métricas apagado no debería
// convertir un commit sano en un commit roto.
pipeline {
  agent any

  options {
    timestamps()
    timeout(time: 30, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    // El escáner y el servidor viven en la misma red de compose.
    SONAR_HOST_URL = "${env.SONAR_HOST_URL ?: 'http://sonarqube:9000'}"
    // Los tests de red montan mallas simuladas: no hacen falta navegadores para esta parte.
    CI = 'true'
  }

  stages {

    stage('Dependencias') {
      steps {
        // `npm ci` y no `npm install`: la construcción tiene que salir del lockfile, no de lo que
        // resuelva el registro hoy.
        sh 'node --version && npm --version'
        sh 'npm ci'
      }
    }

    stage('Tipos') {
      steps {
        // TypeScript en modo estricto sobre los cuatro workspaces. Barato y atrapa mucho.
        sh 'npm run typecheck'
      }
    }

    stage('Pruebas + cobertura') {
      steps {
        // Vitest en los cuatro paquetes, con informe JUnit para que Jenkins muestre el detalle
        // prueba a prueba y no solo "verde/rojo".
        sh 'npm run test:coverage'
      }
      post {
        always {
          junit allowEmptyResults: true, testResults: '**/reports/junit-*.xml'
          archiveArtifacts artifacts: 'coverage/lcov.info', allowEmptyArchive: true
        }
      }
    }

    stage('Build') {
      steps {
        // El build de Next es donde aparecen los errores que las pruebas no ven (importaciones de
        // servidor en cliente, tamaño del bundle).
        sh 'npm run build'
      }
    }

    stage('Calidad (SonarQube)') {
      steps {
        script {
          // La credencial puede no existir todavía (primer arranque del laboratorio): eso deja el
          // análisis sin hacer, no la construcción rota.
          def token = ''
          try {
            withCredentials([string(credentialsId: 'sonar-token', variable: 'T')]) { token = env.T }
          } catch (ignored) {
            echo 'No hay credencial `sonar-token` en Jenkins.'
          }

          if (!token?.trim()) {
            unstable('Sin token de Sonar: se salta el análisis. Genera uno con `node vv/setup.mjs`.')
            return
          }

          def status = sh(returnStatus: true, script: """
            sonar-scanner \
              -Dsonar.host.url='${env.SONAR_HOST_URL}' \
              -Dsonar.token='${token}' \
              -Dsonar.scm.disabled=true
          """)
          if (status != 0) unstable('El análisis de SonarQube no pudo completarse.')
        }
      }
    }

    stage('Seguridad (banco de ataques WS)') {
      steps {
        // Levanta la señalización de verdad y le lanza replay, flooding, spoofing y basura.
        // Si un ataque que antes se bloqueaba pasa a colarse, el commit se cae aquí.
        sh 'npm run vv:security'
      }
      post {
        always {
          archiveArtifacts artifacts: 'vv/informes/seguridad-*.json', allowEmptyArchive: true
        }
      }
    }

    stage('Validación distribuida') {
      steps {
        // Convergencia, orden causal, exclusión mutua y recuperación, con tiempos medidos.
        sh 'npm run vv:distributed'
      }
      post {
        always {
          archiveArtifacts artifacts: 'vv/informes/distribuida-*.json', allowEmptyArchive: true
        }
      }
    }
  }

  post {
    always {
      echo "Resultado: ${currentBuild.currentResult}"
      cleanWs(notFailBuild: true)
    }
  }
}
