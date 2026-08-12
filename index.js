const https = require('https');

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
    this.pollInterval = (this.config.pollInterval || 3) * 1000;

    this.accessories = [];
    this.lastButtonIsOn = {}; // Zapamiętanie stanu isOn dla przycisku Sonoff

    if (!this.host || !this.token) {
      this.log.error('Brak hosta lub tokena Dirigery w konfiguracji!');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.fetchAndProcessDevices();
      setInterval(() => this.fetchAndProcessDevices(), this.pollInterval);
    });
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

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
          this.log.error(`Błąd parsowania JSON: ${err.message}`);
        }
      });
    });

    req.on('error', (err) => {
      this.log.error(`Błąd połączenia z Dirigera: ${err.message}`);
    });

    req.end();
  }

  handleDevice(device) {
    const uuid = this.api.hap.uuid.generate(device.id);
    const existingAccessory = this.accessories.find(acc => acc.UUID === uuid);

    const model = (device.attributes?.model || '').toLowerCase();
    const customName = (device.attributes?.customName || '').toLowerCase();
    const deviceType = (device.deviceType || '').toLowerCase();

    // 1. CZUJNIK RUCHU (Motion Sensor) - sprawdzamy priorytetowo przed obecnością!
    if (
      deviceType.includes('motion') || 
      model.includes('motion') || 
      customName.includes('motion') || 
      device.attributes?.isMotionDetected !== undefined
    ) {
      this.setupMotionSensor(device, uuid, existingAccessory);
    }
    // 2. CZUJNIK OBECNOŚCI (Occupancy Sensor)
    else if (deviceType === 'occupancysensor' || device.attributes?.isDetected !== undefined) {
      this.setupOccupancySensor(device, uuid, existingAccessory);
    }
    // 3. CZUJNIK NATĘŻENIA ŚWIATŁA
    else if (deviceType === 'lightsensor' || device.attributes?.illuminance !== undefined) {
      this.setupLightSensor(device, uuid, existingAccessory);
    }
    // 4. PRZYCISK SONOFF (SNZB-01P)
    else if (model.includes('snzb-01p') || customName.includes('button') || customName.includes('przycisk')) {
      this.setupSonoffButton(device, uuid, existingAccessory);
    }
    // 5. ŻARÓWKA / ŚCIEMNIACZ / PRZEŁĄCZNIK ŚWIATŁA
    else if (device.type === 'light' || (device.attributes?.isOn !== undefined && deviceType === 'lightcontroller' === false)) {
      this.setupLightbulb(device, uuid, existingAccessory);
    }
    // 6. TERMOSTAT / CZUJNIK TEMPERATURY
    else if (device.attributes?.currentTemperature !== undefined) {
      this.setupThermostat(device, uuid, existingAccessory);
    }
  }

  // --- CZUJNIK RUCHU (MOTION SENSOR) ---
  setupMotionSensor(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Czujnik Ruchu';
    // Pobieramy wykrycie z isMotionDetected lub awaryjnie z isDetected
    const motionDetected = device.attributes?.isMotionDetected ?? device.attributes?.isDetected ?? false;
    
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie CZUJNIKA RUCHU: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.addService(Service.MotionSensor, name);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const service = accessory.getService(Service.MotionSensor);
    service.updateCharacteristic(Characteristic.MotionDetected, Boolean(motionDetected));

    // Bateria w czujniku
    if (device.attributes?.batteryPercentage !== undefined) {
      this.updateBattery(accessory, name, device.attributes.batteryPercentage);
    }
  }

  // --- CZUJNIK OBECNOŚCI (OCCUPANCY SENSOR) ---
  setupOccupancySensor(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Czujnik Obecnosci';
    const isDetected = device.attributes?.isDetected || false;
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie czujnika obecności: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.addService(Service.OccupancySensor, name);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const service = accessory.getService(Service.OccupancySensor);
    const state = isDetected 
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED 
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;

    service.updateCharacteristic(Characteristic.OccupancyDetected, state);

    if (device.attributes?.batteryPercentage !== undefined) {
      this.updateBattery(accessory, name, device.attributes.batteryPercentage);
    }
  }

  // --- PRZYCISK SONOFF (SNZB-01P) ---
  setupSonoffButton(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Sonoff Button';
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie PRZYCISKU SONOFF: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      
      const btnService = accessory.addService(Service.StatelessProgrammableSwitch, name);
      btnService.getCharacteristic(Characteristic.ServiceLabelIndex).setValue(1);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // Wykrywanie kliknięcia po zmianie wartości isOn w API
    const currentIsOn = device.attributes?.isOn;
    if (this.lastButtonIsOn[device.id] !== undefined && this.lastButtonIsOn[device.id] !== currentIsOn) {
      this.log.info(`Naciśnięto przycisk ${name}!`);
      const btnService = accessory.getService(Service.StatelessProgrammableSwitch);
      btnService.updateCharacteristic(
        Characteristic.ProgrammableSwitchEvent, 
        Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS
      );
    }
    this.lastButtonIsOn[device.id] = currentIsOn;

    // Poziom baterii (100%)
    if (device.attributes?.batteryPercentage !== undefined) {
      this.updateBattery(accessory, name, device.attributes.batteryPercentage);
    }
  }

  // --- CZUJNIK ŚWIATŁA ---
  setupLightSensor(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Czujnik Swiatla';
    const lux = Math.max(device.attributes?.illuminance || 0.0001, 0.0001);
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie czujnika światła: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      accessory.addService(Service.LightSensor, name);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const service = accessory.getService(Service.LightSensor);
    service.updateCharacteristic(Characteristic.CurrentAmbientLightLevel, lux);
  }

  // --- ŻARÓWKA / ŚWIATŁO ---
  setupLightbulb(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Światło Dirigera';
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie żarówki: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      const lightService = accessory.addService(Service.Lightbulb, name);

      lightService.getCharacteristic(Characteristic.On)
        .onSet((value) => this.sendDeviceCommand(device.id, [{ attributes: { isOn: value } }]));

      if (device.attributes?.lightLevel !== undefined) {
        lightService.getCharacteristic(Characteristic.Brightness)
          .onSet((value) => this.sendDeviceCommand(device.id, [{ attributes: { lightLevel: value } }]));
      }

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const lightService = accessory.getService(Service.Lightbulb);

    if (device.attributes?.isOn !== undefined) {
      lightService.updateCharacteristic(Characteristic.On, device.attributes.isOn);
    }

    if (device.attributes?.lightLevel !== undefined) {
      lightService.updateCharacteristic(Characteristic.Brightness, device.attributes.lightLevel);
    }
  }

  // --- TERMOSTAT ---
  setupThermostat(device, uuid, existingAccessory) {
    const name = device.attributes?.customName || 'Termostat Sonoff';
    const temp = device.attributes?.currentTemperature || 20;
    const humidity = device.attributes?.currentRH;

    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let accessory = existingAccessory;

    if (!accessory) {
      this.log.info(`Dodawanie nowego termostatu: ${name}`);
      accessory = new this.api.platformAccessory(name, uuid);
      
      const thermostatService = accessory.addService(Service.Thermostat, name);
      
      thermostatService.setCharacteristic(Characteristic.TargetTemperature, 21);
      thermostatService.setCharacteristic(Characteristic.CurrentHeatingCoolingState, Characteristic.CurrentHeatingCoolingState.OFF);
      thermostatService.setCharacteristic(Characteristic.TargetHeatingCoolingState, Characteristic.TargetHeatingCoolingState.OFF);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    const thermostatService = accessory.getService(Service.Thermostat);
    thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, temp);

    if (humidity !== undefined) {
      thermostatService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
    }

    if (device.attributes?.batteryPercentage !== undefined) {
      this.updateBattery(accessory, name, device.attributes.batteryPercentage);
    }
  }

  // --- POMOCNICZA FUNKCJA DLA BATERII ---
  updateBattery(accessory, name, level) {
    const Service = this.api.hap.Service;
    const Characteristic = this.api.hap.Characteristic;

    let batteryService = accessory.getService(Service.Battery);
    if (!batteryService) {
      batteryService = accessory.addService(Service.Battery, `${name} Bateria`);
    }
    batteryService.updateCharacteristic(Characteristic.BatteryLevel, level);
    batteryService.updateCharacteristic(
      Characteristic.StatusLowBattery, 
      level < 20 ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
    );
  }

  // --- WYSYŁANIE KOMEND DO DIRIGERY ---
  sendDeviceCommand(deviceId, patchData) {
    const payload = JSON.stringify(patchData);
    const options = {
      hostname: this.host,
      port: 8443,
      path: `/v1/devices/${deviceId}`,
      method: 'PATCH',
      rejectUnauthorized: false,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        this.log.debug(`Pomyślnie wysłano komendę do urządzenia ${deviceId}`);
      } else {
        this.log.error(`Błąd sterowania urządzeniem ${deviceId}: HTTP ${res.statusCode}`);
      }
    });

    req.on('error', (err) => {
      this.log.error(`Błąd zapytania PATCH do Dirigery: ${err.message}`);
    });

    req.write(payload);
    req.end();
  }
}
