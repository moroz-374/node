export interface TrafficAuditAccessLogEvent {
    clientIdentifier: string;

    destination: string;
    destinationType: 'DOMAIN' | 'IPV4' | 'IPV6' | 'UNKNOWN';

    network: 'tcp' | 'udp';
    port: number;

    originalDestination?: string;
    originalDestinationType?: 'DOMAIN' | 'IPV4' | 'IPV6' | 'UNKNOWN';
    originalNetwork?: 'tcp' | 'udp';
    originalPort?: number;
    sniffedProtocol?: string;

    requestedAt: string;
}

const ACCESS_LOG_REGEXP =
    /^(?<date>\d{4}\/\d{2}\/\d{2}) (?<time>\d{2}:\d{2}:\d{2}(?:\.\d+)?) (?:from )?(?<source>\S+) accepted (?<network>tcp|udp):(?<destination>\S+)(?: \[(?<inbound>[^\]]+)])?(?: email: (?<email>\S+))?(?: original: (?<original>(?:tcp|udp):\S+) sniffed: (?<sniffed>[a-z0-9][a-z0-9+._-]*))?$/;

export function parseTrafficAuditAccessLogLine(line: string): TrafficAuditAccessLogEvent | null {
    const match = ACCESS_LOG_REGEXP.exec(line.trim());

    if (!match?.groups) {
        return null;
    }

    const clientIdentifier = match.groups.email;

    if (!clientIdentifier) {
        return null;
    }

    const parsedDestination = parseDestination(match.groups.destination);
    const network = match.groups.network;

    if (!parsedDestination || !isNetwork(network)) {
        return null;
    }

    const event: TrafficAuditAccessLogEvent = {
        clientIdentifier,
        destination: parsedDestination.destination,
        destinationType: parsedDestination.destinationType,
        network,
        port: parsedDestination.port,
        requestedAt: parseXrayTimestamp(match.groups.date, match.groups.time),
    };

    if (match.groups.original || match.groups.sniffed) {
        const original = match.groups.original;
        const sniffed = match.groups.sniffed;
        const parsedOriginalDestination = original ? parseTypedDestination(original) : null;

        if (!parsedOriginalDestination || !sniffed) {
            return null;
        }

        event.originalDestination = parsedOriginalDestination.destination;
        event.originalDestinationType = parsedOriginalDestination.destinationType;
        event.originalNetwork = parsedOriginalDestination.network;
        event.originalPort = parsedOriginalDestination.port;
        event.sniffedProtocol = sniffed;
    }

    return event;
}

function parseTypedDestination(rawDestination: string): {
    destination: string;
    destinationType: TrafficAuditAccessLogEvent['destinationType'];
    network: TrafficAuditAccessLogEvent['network'];
    port: number;
} | null {
    const separatorIndex = rawDestination.indexOf(':');

    if (separatorIndex === -1) {
        return null;
    }

    const network = rawDestination.slice(0, separatorIndex);

    if (!isNetwork(network)) {
        return null;
    }

    const parsedDestination = parseDestination(rawDestination.slice(separatorIndex + 1));

    if (!parsedDestination) {
        return null;
    }

    return {
        ...parsedDestination,
        network,
    };
}

function parseDestination(rawDestination: string): {
    destination: string;
    destinationType: TrafficAuditAccessLogEvent['destinationType'];
    port: number;
} | null {
    const normalized = rawDestination.trim();

    if (!normalized) {
        return null;
    }

    const bracketIpv6 = /^\[(?<host>.+)]:(?<port>\d+)$/.exec(normalized);

    if (bracketIpv6?.groups) {
        return buildParsedDestination(bracketIpv6.groups.host, bracketIpv6.groups.port);
    }

    const lastColonIndex = normalized.lastIndexOf(':');

    if (lastColonIndex === -1) {
        return null;
    }

    const host = normalized.slice(0, lastColonIndex);
    const port = normalized.slice(lastColonIndex + 1);

    return buildParsedDestination(host, port);
}

function buildParsedDestination(
    host: string,
    portString: string,
): {
    destination: string;
    destinationType: TrafficAuditAccessLogEvent['destinationType'];
    port: number;
} | null {
    const port = Number(portString);

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return null;
    }

    const destination = normalizeDestination(host);

    if (!destination) {
        return null;
    }

    return {
        destination,
        destinationType: getDestinationType(destination),
        port,
    };
}

function normalizeDestination(host: string): string {
    return host.trim().toLowerCase().replace(/\.$/, '');
}

function getDestinationType(destination: string): TrafficAuditAccessLogEvent['destinationType'] {
    if (isIpv4(destination)) {
        return 'IPV4';
    }

    if (destination.includes(':')) {
        return 'IPV6';
    }

    if (destination.includes('.')) {
        return 'DOMAIN';
    }

    return 'UNKNOWN';
}

function isIpv4(value: string): boolean {
    const parts = value.split('.');

    if (parts.length !== 4) {
        return false;
    }

    return parts.every((part) => {
        if (!/^\d+$/.test(part)) {
            return false;
        }

        const number = Number(part);

        return number >= 0 && number <= 255;
    });
}

function isNetwork(value: string): value is TrafficAuditAccessLogEvent['network'] {
    return value === 'tcp' || value === 'udp';
}

function parseXrayTimestamp(date: string, time: string): string {
    const isoLike = `${date.replaceAll('/', '-')}T${time}`;

    return new Date(isoLike).toISOString();
}
