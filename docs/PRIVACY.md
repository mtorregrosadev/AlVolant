# Privacitat d’AlVolant

Última actualització: 12 de juliol de 2026.

AlVolant és una app de conducció sense compte d’usuari. No mostra publicitat, no crea perfils comercials, no ven dades i no utilitza dades per seguir una persona entre apps o serveis de tercers. Aquesta política descriu el tractament fet pel codi d’aquest repositori; una distribució pública haurà de publicar també les dades de contacte legals del responsable.

## Dades i finalitat

### Ubicació mentre s’utilitza l’app

L’app demana ubicació en primer pla per ordenar les línies segons les parades properes, mostrar la posició del vehicle durant el servei i consultar l’estat del trànsit de l’entorn. No sol·licita ubicació en segon pla.

- Proximitat: el client arrodoneix latitud i longitud a tres decimals abans d’enviar-les al BFF. El BFF les usa per calcular distàncies i no les persisteix.
- Mapa: les mostres GPS utilitzades per dibuixar i ajustar la posició es processen al dispositiu i no formen part de la telemetria.
- Trànsit: la mostra exacta arriba transitòriament al BFF dins el cos JSON d’un `POST`, no a la URL. No es registra ni es persisteix; el servei la valida i l’arrodoneix a tres decimals abans d’enviar-la a TomTom i usar-la a la cache acotada.

Apple considera «ubicació precisa» una coordenada amb tres decimals o més. Per això el manifest iOS declara prudentment `NSPrivacyCollectedDataTypePreciseLocation`, encara que el flux sigui funcional, efímer, no vinculat a identitat i sense tracking.

### Interacció i diagnòstics

La telemetria pròpia permet detectar errors i regressions. Pot incloure:

- inici o pas a segon pla de l’app i pantalla visitada;
- fases funcionals com seleccionar o iniciar un servei, sense l’identificador de línia, trajecte o vehicle;
- idioma i canvi d’una preferència enumerada;
- endpoint lògic, mètode, estat i durada acotada d’una petició;
- tipus genèric d’error JavaScript i fase on s’ha produït;
- avís de memòria i estat de càrrega del mapa.

No s’accepten coordenades, textos de cerca, identificadors de ruta, viatge o vehicle, URL completes, query strings, cossos o capçaleres HTTP, missatges d’error, traces, correus ni directoris d’usuari. El client limita i saneja els camps; el contracte del BFF aplica una llista tancada i el servidor torna a redactar el contingut abans de desar-lo.

El manifest iOS declara interacció de producte per analítica i dades de crash i rendiment per funcionalitat. Tots aquests tipus consten com a no vinculats a identitat i no utilitzats per tracking.

### Preferències locals

Favorites, fins a quatre recents, idioma i color del vehicle es desen exclusivament al dispositiu amb AsyncStorage. No s’envien com a perfil al BFF. Es poden eliminar esborrant les dades de l’app o desinstal·lant-la.

## Identificadors i retenció

No hi ha compte, nom, correu, número de telèfon, identificador publicitari ni identificador persistent de dispositiu. A cada execució el client crea una sessió aleatòria efímera; el BFF només desa un hash curt per ordenar esdeveniments de la mateixa sessió, no per reconèixer la persona en una sessió posterior.

La telemetria es guarda a Redis durant tres dies per defecte. El servei imposa un màxim de retenció de 30 dies, quotes diàries, una cua acotada i un màxim separat d’errors. No hi ha cap endpoint HTTP de lectura: el manteniment consulta els agregats directament des d’un entorn administratiu amb accés a Redis.

## Destinataris i transferències tècniques

- El BFF operat pel responsable del desplegament rep les peticions funcionals i la telemetria descrita.
- TomTom rep una coordenada arrodonida només quan l’app demana informació de trànsit.
- ATM/T-mobilitat és una font d’entrada de dades GTFS i GTFS-Realtime; no rep ubicació ni telemetria de l’usuari des d’aquest codi.
- TestFlight i l’App Store poden facilitar informes natius de crash i diagnòstic segons la configuració i les condicions d’Apple. Aquest canal és independent de la telemetria JavaScript pròpia.

La distribució de producció ha d’usar HTTPS/WSS. Els secrets del servidor, la base Redis i els informes de diagnòstic no s’han d’exposar a Internet.

## Controls de l’usuari

Es pot denegar o revocar el permís d’ubicació des d’Ajustos d’iOS. Sense el permís, no estan disponibles l’ordenació per proximitat ni la posició GPS en directe, però es poden continuar consultant i seleccionant línies. Les preferències locals s’eliminen amb les dades de l’app.

Per informar d’una incidència de privacitat al projecte, obre una incidència a [GitHub](https://github.com/mtorregrosadev/AlVolant/issues) sense incloure dades personals, coordenades, claus ni logs complets.

## Obligacions abans de publicar

El manifest `PrivacyInfo.xcprivacy` generat per Expo no substitueix les respostes de privacitat d’App Store Connect ni una política legal publicada. Abans de distribuir cal:

1. generar una archive signada i revisar el Privacy Report agregat d’Xcode;
2. mantenir les declaracions d’App Store Connect alineades amb el binari i els SDKs reals;
3. provar la build a TestFlight i revisar crashes natius i diagnòstics;
4. actualitzar aquesta política si canvien els camps, la retenció, els proveïdors o les finalitats.

## Referències oficials

- [Apple: Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)
- [Apple: Describing data use in privacy manifests](https://developer.apple.com/documentation/bundleresources/describing-data-use-in-privacy-manifests)
- [Apple: App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/)
- [Apple: Acquiring crash reports and diagnostic logs](https://developer.apple.com/documentation/xcode/acquiring-crash-reports-and-diagnostic-logs)
- [Expo: Privacy manifests](https://docs.expo.dev/guides/apple-privacy/)
