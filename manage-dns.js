/* eslint-disable @typescript-eslint/no-var-requires */
require("dotenv").config(); // Load .env file variables
const fs = require("fs").promises;
const yaml = require("js-yaml");
const axios = require("axios");

const { PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY, DOMAIN } = process.env;
const COMPOSE_FILE = "docker-compose.yml";
const PORKBUN_API_URL = "https://api.porkbun.com/api/json/v3";

if (!PORKBUN_API_KEY || !PORKBUN_SECRET_API_KEY || !DOMAIN) {
	console.error(
		"Error: Missing required environment variables in .env file: PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY, DOMAIN"
	);
	process.exit(1);
}

// --- Helper Functions ---

async function getPublicIp() {
	try {
		console.log("Fetching public IP address...");
		const response = await axios.get("https://api.ipify.org?format=json");
		console.log(`Public IP address: ${response.data.ip}`);
		return response.data.ip;
	} catch (error) {
		console.error(
			"Error fetching public IP:",
			error.response ? error.response.data : error.message
		);
		throw error;
	}
}

async function getHostsFromCompose(filePath) {
	const hosts = new Set();
	try {
		console.log(`Reading hostnames from ${filePath}...`);
		const fileContent = await fs.readFile(filePath, "utf8");
		const composeConfig = yaml.load(fileContent);

		if (composeConfig?.services) {
			for (const serviceConfig of Object.values(composeConfig.services)) {
				if (serviceConfig.labels && Array.isArray(serviceConfig.labels)) {
					for (const label of serviceConfig.labels) {
						if (typeof label === "string" && label.includes("rule=Host(`")) {
							try {
								const hostPart = label.split("Host(`")[1].split("`)")[0];
								// Extract only the subdomain part
								const hostname = hostPart.split(".")[0];
								// Basic validation: avoid adding the base domain or empty strings
								if (
									hostname &&
									hostname !== DOMAIN &&
									!hostname.includes("*") &&
									!hostname.includes(",")
								) {
									hosts.add(hostname);
								}
							} catch (e) {
								console.warn(`Could not parse hostname from label: ${label}`);
							}
						}
					}
				}
			}
		}
		const hostArray = Array.from(hosts);
		console.log(`Found potential hostnames: ${hostArray.join(", ")}`);
		return hostArray;
	} catch (error) {
		console.error(`Error reading or parsing ${filePath}:`, error.message);
		throw error;
	}
}

async function porkbunApiRequest(endpoint, payload = {}) {
	const url = `${PORKBUN_API_URL}${endpoint}`;
	const data = {
		apikey: PORKBUN_API_KEY,
		secretapikey: PORKBUN_SECRET_API_KEY,
		...payload,
	};
	console.log(data);
	console.log(url);
	try {
		const response = await axios.post(url, data, {
			headers: { "Content-Type": "application/json" },
		});
		if (response.data.status !== "SUCCESS") {
			console.warn(`Porkbun API Warning for ${endpoint}: ${response.data.message}`);
			// Treat 'record not found' specifically in the calling function if needed
		}
		return response.data;
	} catch (error) {
		console.error(
			`Porkbun API Error for ${endpoint}:`,
			error.response ? JSON.stringify(error.response.data, null, 2) : error.message
		);
		// Don't throw here necessarily, allow individual record management to fail gracefully
		return { status: "ERROR", message: error.message }; // Return error status for handling
	}
}

async function manageDnsRecord(host, publicIp) {
	const fqdn = `${host}.${DOMAIN}`;
	console.log(`---
Managing DNS for: ${fqdn}`);

	try {
		// Check if record exists
		const retrieveEndpoint = `/dns/retrieveByNameType/${DOMAIN}/A/${host}`;
		console.log(`Checking existing record via ${retrieveEndpoint}...`);
		const existing = await porkbunApiRequest(retrieveEndpoint);

		if (existing.status === "SUCCESS" && existing.records?.length > 0) {
			const currentIp = existing.records[0].content;
			console.log(`Found existing A record pointing to: ${currentIp}`);
			if (currentIp === publicIp) {
				console.log(`IP address is already correct. No update needed for ${fqdn}.`);
				return; // IP matches, nothing to do
			}

			// IP Mismatch - Update record
			console.log(`IP mismatch. Updating record for ${fqdn} to ${publicIp}...`);
			const updateEndpoint = `/dns/editByNameType/${DOMAIN}/A/${host}`;
			const updatePayload = {
				name: host,
				type: "A", // Ensure type is passed for edit
				content: publicIp,
				ttl: "300", // Or your preferred TTL
			};
			const updateResult = await porkbunApiRequest(updateEndpoint, updatePayload);
			if (updateResult.status === "SUCCESS") {
				console.log(`Successfully updated record for ${fqdn}.`);
			} else {
				console.error(
					`Failed to update record for ${fqdn}. API Message: ${updateResult.message}`
				);
			}
		} else {
			// Record doesn't exist or couldn't be retrieved - Create it
			// Check if the error message indicates 'Record not found', otherwise it might be another issue
			const isNotFoundError = existing.message
				?.toLowerCase()
				.includes("could not find record");
			if (existing.status !== "SUCCESS" && !isNotFoundError) {
				console.error(
					`Failed to retrieve record for ${fqdn} due to an unexpected API issue. Skipping creation.`
				);
				return;
			}

			console.log(
				`No existing A record found or IP mismatch. Creating record for ${fqdn} pointing to ${publicIp}...`
			);
			const createEndpoint = `/dns/create/${DOMAIN}`;
			const createPayload = {
				name: host,
				type: "A",
				content: publicIp,
				ttl: "300",
			};
			const createResult = await porkbunApiRequest(createEndpoint, createPayload);
			if (createResult.status === "SUCCESS") {
				console.log(`Successfully created record for ${fqdn}.`);
			} else {
				console.error(
					`Failed to create record for ${fqdn}. API Message: ${createResult.message}`
				);
			}
		}
	} catch (error) {
		// Catch any unexpected errors during the process for this specific host
		console.error(`Unexpected error managing DNS for ${fqdn}:`, error.message);
	}
}

// --- Main Execution ---

async function main() {
	console.log("Starting DNS Management Script...");
	try {
		// 1. Ping Porkbun API to check credentials early
		console.log("Pinging Porkbun API to verify credentials...");
		const pingResult = await porkbunApiRequest("/ping");
		if (pingResult.status !== "SUCCESS") {
			console.error(
				`Porkbun API Ping Failed: ${pingResult.message || "Unknown Error"}. Check API Keys.`
			);
			process.exit(1);
		}
		console.log("Porkbun API credentials verified.");

		// 2. Get public IP and required hostnames
		const [currentIp, requiredHosts] = await Promise.all([
			getPublicIp(),
			getHostsFromCompose(COMPOSE_FILE),
		]);

		if (!currentIp || requiredHosts.length === 0) {
			console.error("Could not fetch public IP or no hosts found in compose file. Exiting.");
			process.exit(1);
		}

		// 3. Manage DNS for each host sequentially to avoid overwhelming the API
		console.log("\nStarting DNS record checks and updates...");
		for (const host of requiredHosts) {
			await manageDnsRecord(host, currentIp);
		}

		console.log("---\nDNS Management Script finished successfully.");
	} catch (error) {
		console.error("\nScript failed unexpectedly:", error.message);
		process.exit(1);
	}
}

main();
