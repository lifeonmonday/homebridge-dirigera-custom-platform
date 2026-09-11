const https = require('https');
const WebSocket = require('ws');

const PLUGIN_NAME = 'homebridge-dirigera-custom-platform';
const PLATFORM_NAME = 'DirigeraCustomPlatform';

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, DirigeraCustomPlatform);
};

class DirigeraCustomPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.host = this.config.host;
    this.token = this.config.token;
    this.pollInterval = (this.config.pollInterval || 5) * 1000;

    this.accessories = [];
    this.ws = null;

    if (!this.host || !this.token) {
      this.log.error('Brak hosta lub tokena Dirigery w konfiguracji!');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      // Cykliczne pobieranie stanu (termostat, czujnik obecności)
      this.fetchAndProcessDevices();
      setInterval(() => this.fetchAndProcessDevices(), this.pollInterval);

      // WebSocket dla zdarzeń przycisków w czasie rzeczywistym
      this.initWebSocket();
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  // --- OBSŁUGA STRUMIENIA WEBSOCKET ---
  initWebSocket() {
    const wsUrl = `wss://${this.host}:8443/v1/subscribe`;

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      },
      rejectUnauthorized: false
    });

    this.ws.on('open', () => {
      this.log.info('Połączono ze strumieniem zdarzeń WebSocket Dirigery!');
    });

    this.ws.on('message', (data) => {
      try {
        const event = JSON.parse(data);

        // Prchwytywanie kliknięć z pilotów
        if (event.type === 'remotePressEvent' && event.data?.id) {
          this.handleRemotePress(event.data.id, event.data.clickPattern);
        }
      } catch (err) {
        this.log.error(`Błąd dekodowania zdarzenia WS: ${err.message}`);
      }
    });

    this.ws.on('error', (err) => {
      this.log.error(`Błąd połączenia WebSocket: ${err.message}`);
    });

    this.ws.on('close', () => {
      this.log.warn('WebSocket zamknięty. Ponowne łączenie za 5s...');
      setTimeout(() => this.initWebSocket(), 5000);
    });
  }

  handleRemotePress(deviceId, clickPattern) {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    // 1. Walidacja i mapowanie kliknięcia (Early exit, jeśli zdarzenie nie jest kliknięciem)
    let eventValue;
    if (clickPattern === 'singlePress') {
      eventValue = Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
    } else if (clickPattern === 'doublePress') {
      eventValue = Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS;
    } else if (clickPattern === 'longPress') {
      eventValue = Characteristic.ProgrammableSwitchEvent.LONG_PRESS;
    }

    if (eventValue === undefined) return;

    // 2. Znalezienie akcesorium i odpowiedniego serwisu
    // Najpierw sprawdzamy pojedynczy przycisk (Sonoff - pełny deviceId)
    const directUuid = this.api.hap.uuid.generate(deviceId);
    let accessory = this.accessories.find(acc => acc.UUID === directUuid);
    let buttonService = null;

    if (accessory) {
      buttonService = accessory.getService(Service.StatelessProgrammableSwitch);
    } else {
      // Dwuprzyciskowy (BILRESA - bazowy ID bez _1 / _2)
      const baseId = deviceId.split('_')[0];
      const buttonNumber = deviceId.split('_')[1];
      const baseUuid = this.api.hap.uuid.generate(baseId);

      accessory = this.accessories.find(acc => acc.UUID === baseUuid);
      if (accessory) {
        buttonService = accessory.getServiceById(
          Service.StatelessProgrammableSwitch,
          `button_${buttonNumber}`
        );
      }
    }

    if (!accessory || !buttonService) return;

    // 3. Wysłanie stanu do HomeKit
    this.log.info(`Pilot ${accessory.displayName}: ${clickPattern}`);
    buttonService.updateCharacteristic(Characteristic.ProgrammableSwitchEvent, eventValue);
  }

  // --- ODCZYT URZĄDZEŃ PRZEZ REST API ---
  fetchAndProcessDevices() {
    const options = {
      hostname: this.host,
      port: 8443,
      path: '/v1/devices',
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          this.log.error(`Błąd API Dirigery: HTTP ${res.statusCode}`);
          return;
        }

        try {
          const devices = JSON.parse(data);
          for (const device of devices) {
            this.handleDevice(device);
          }
        } catch (err) {
          this.log.error(`Błąd przetwarzania danych: ${err.message}`);
        }
      });
    });

    req.on('error', (err) => {
      this.log.error(`Błąd połączenia z Dirigera: ${err.message}`);
    });

    req.end();
  }

  handleDevice(device) {
    const deviceType = device.deviceType;
    const model = device.attributes?.model;

    // 1. TERMOSTAT (Z czujnika temperatury)
    if (device.attributes?.currentTemperature !== undefined) {
      const uuid = this.api.hap.uuid.generate(device.id);
      const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);
      this.setupThermostat(device, uuid, existingAccessory);
    }
    // 2. CZUJNIK OBECNOŚCI
    else if (deviceType === 'occupancySensor') {
      const uuid = this.api.hap.uuid.generate(device.id);
      const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);
      this.setupOccupancySensor(device, uuid, existingAccessory);
    }
    // 3. PILOT SONOFF (SNZB-01P)
    else if (deviceType === 'lightController' && model === 'SNZB-01P') {
      const uuid = this.api.hap.uuid.generate(device.id);
      const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);
      this.setupSingleButton(device, uuid, existingAccessory);
    }
    // 4. PILOTY BILRESA
    else if (deviceType === 'genericSwitch') {
      // Ucinamy _1/_2 z ID, aby zepiąć oba przyciski w jedno akcesorium HomeKit
      const baseId = device.id.split('_')[0];
      const uuid = this.api.hap.uuid.generate(baseId);
      const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);
      this.setupDualButton(device, uuid, existingAccessory);
    }
  }

  getOrCreateService(accessory, serviceType, name) {
    let service = accessory.getService(serviceType);
    if (!service) {
      service = accessory.addService(serviceType, name);
    }
    return service;
  }

  updateAccessoryInformation(accessory, device) {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;
    const infoService = accessory.getService(Service.AccessoryInformation);

    if (infoService) {
      infoService
        .setCharacteristic(Characteristic.Manufacturer, device.attributes?.manufacturer || 'IKEA / Sonoff')
        .setCharacteristic(Characteristic.Model, device.attributes?.model || device.deviceType || 'Unknown')
        .setCharacteristic(Characteristic.SerialNumber, device.attributes?.serialNumber || device.id)
        .setCharacteristic(Characteristic.FirmwareRevision, device.attributes?.firmwareVersion || '1.0.0');
    }
  }

  // --- TERMOSTAT ---
  setupThermostat(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Thermostat';
    const temp = device.attributes?.currentTemperature || 20;
    const humidity = device.attributes?.currentRH;

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie Termostatu: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    this.updateAccessoryInformation(accessory, device);

    const thermostatService = this.getOrCreateService(accessory, Service.Thermostat, name);

    thermostatService.setCharacteristic(Characteristic.TargetTemperature, 21);

    thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({
        validValues: [Characteristic.TargetHeatingCoolingState.OFF]
      });

    if (!thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState).listeners('set').length) {
      thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
        .onSet(() => {
          setTimeout(() => {
            thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);
            thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
          }, 50);
        });
    }

    thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
    thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);

    thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, temp);

    if (humidity !== undefined) {
      thermostatService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
    }
  }

  // --- CZUJNIK OBECNOŚCI ---
  setupOccupancySensor(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Occupancy Sensor';
    const isDetected = device.attributes?.isDetected || false;

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie Czujnika Obecności: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    this.updateAccessoryInformation(accessory, device);

    const service = this.getOrCreateService(accessory, Service.OccupancySensor, name);
    const state = isDetected
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;

    service.updateCharacteristic(Characteristic.OccupancyDetected, state);
  }

  // --- PILOTY (PROGRAMMABLE SWITCH) ---
  // --- Pilot pojedynczy (SONOFF) ---
  setupSingleButton(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Sonoff Button';
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Rejestracja pilota Sonoff: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);

      const buttonService = accessory.addService(Service.StatelessProgrammableSwitch, name);
      buttonService.getCharacteristic(Characteristic.ProgrammableSwitchEvent)
        .setProps({
          validValues: [
            Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
          ]
        });

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    this.updateAccessoryInformation(accessory, device);
  }

  // --- Pilot dwuprzyciskowy (BILRESA) ---
  setupDualButton(device, uuid, existingAccessory) {
    const rawName = device.attributes?.customName || 'BILRESA Switch';
    const name = rawName.replace(/_[0-9]+$/, '');
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Rejestracja pilota BILRESA: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);

      // Etykieta nadrzędna grupująca przyciski w HomeKit
      const labelService = accessory.addService(Service.ServiceLabel, name);
      labelService.setCharacteristic(Characteristic.ServiceLabelNamespace, Characteristic.ServiceLabelNamespace.ARABIC_NUMERALS);

      const dualProps = {
        validValues: [
          Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
          Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
          Characteristic.ProgrammableSwitchEvent.LONG_PRESS
        ]
      };

      // Przycisk 1 (Top)
      const btn1 = accessory.addService(Service.StatelessProgrammableSwitch, 'Top Button', 'button_1');
      btn1.setCharacteristic(Characteristic.ServiceLabelIndex, 1);
      btn1.getCharacteristic(Characteristic.ProgrammableSwitchEvent).setProps(dualProps);

      // Przycisk 2 (Bottom)
      const btn2 = accessory.addService(Service.StatelessProgrammableSwitch, 'Bottom Button', 'button_2');
      btn2.setCharacteristic(Characteristic.ServiceLabelIndex, 2);
      btn2.getCharacteristic(Characteristic.ProgrammableSwitchEvent).setProps(dualProps);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    this.updateAccessoryInformation(accessory, device);
  }
}
