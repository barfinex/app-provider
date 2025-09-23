export interface PortainerContainer {
    Id: string; // Уникальный идентификатор контейнера
    Names: string[]; // Массив имен контейнера
    Image: string; // Используемый образ
    ImageID: string; // Уникальный ID образа
    Command: string; // Команда, используемая для запуска контейнера
    Created: number; // Время создания (Unix timestamp)
    Ports: PortainerPort[]; // Массив портов, используемых контейнером
    Labels: { [key: string]: string }; // Список меток (ключ-значение)
    State: string; // Состояние контейнера (например, running, exited)
    Status: string; // Статус контейнера (например, Up 10 minutes)
    HostConfig: {
        NetworkMode: string; // Сетевой режим контейнера
    };
    NetworkSettings: {
        Networks: { [key: string]: PortainerNetwork }; // Список сетей, к которым подключен контейнер
    };
    Mounts: PortainerMount[]; // Список томов или маунтов
    Logs?: string//PortainerLog[]
}

export interface PortainerPort {
    PrivatePort: number; // Приватный порт внутри контейнера
    PublicPort?: number; // Публичный порт на хосте
    Type: string; // Тип протокола (например, tcp или udp)
}

export interface PortainerNetwork {
    IPAddress: string; // IP-адрес контейнера в сети
    Gateway: string; // Шлюз
    MacAddress: string; // MAC-адрес
    NetworkID: string; // Уникальный ID сети
    EndpointID: string; // Уникальный ID подключения
}

export interface PortainerMount {
    Type: string; // Тип маунта (volume, bind и т.д.)
    Source: string; // Источник (например, путь на хосте)
    Destination: string; // Назначение внутри контейнера
    Mode: string; // Режим (например, ro, rw)
    RW: boolean; // Read/Write доступ
    Propagation: string; // Тип распространения
}

export interface PortainerLog {
    timestamp: string; // Временная метка лога
    stream: 'stdout' | 'stderr'; // Поток: стандартный вывод или ошибки
    message: string; // Сообщение лога
}
