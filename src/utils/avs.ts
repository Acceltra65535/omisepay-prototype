/**
 * International Credit Card Address Verification Service (AVS) Engine
 *
 * Implements strict Visa / Mastercard / American Express / Discover AVS standards:
 * - Street number verification
 * - ISO 3166-1 alpha-2 country validation
 * - Strict postal / ZIP format matching (US ZIP+4, UK BS 7666, Canada Post A1A 1A1, etc.)
 * - State/subdivision code compliance (USPS 2-letter, Canada 2-letter, Australia Post)
 * - String sanitization and max-length safety for payment gateways
 */

import {
  CountryConfig,
  getCountryByCode,
  formatPostalCode,
} from '../config/countries';

export interface BillingAddressData {
  country: string;
  street1: string;
  street2?: string;
  city: string;
  state?: string;
  postalCode?: string;
}

export interface AvsValidationResult {
  isValid: boolean;
  errors: Record<string, string>;
  warnings?: Record<string, string> | undefined;
  firstError?: string | undefined;
}

/**
 * Validate billing address against strict international AVS criteria
 */
export function validateAvsAddress(
  data: BillingAddressData,
  countryConfig?: CountryConfig,
): AvsValidationResult {
  const config = countryConfig || getCountryByCode(data.country);
  const errors: Record<string, string> = {};
  const warnings: Record<string, string> = {};

  // 1. Country Validation
  if (!data.country || data.country.trim().length !== 2) {
    errors.country = 'Please select a valid billing country/region.';
  }

  // 2. Street Address Line 1 Validation
  const street1Trimmed = (data.street1 || '').trim();
  if (!street1Trimmed) {
    errors.street1 = 'Street address is required.';
  } else if (street1Trimmed.length < 3) {
    errors.street1 = 'Street address is too short (minimum 3 characters).';
  } else if (street1Trimmed.length > 50) {
    // Payment card gateway networks limit street address to 50 characters
    errors.street1 = 'Street address must not exceed 50 characters.';
  } else if (config.isAvsStrict) {
    // AVS networks (Visa/MC) specifically extract the leading numeric digits
    // from street1 to match against the cardholder bank's records.
    // If an address has no digits at all, AVS will result in a mismatch or street failure.
    const hasNumber = /\d/.test(street1Trimmed);
    if (!hasNumber) {
      errors.street1 =
        'AVS requires a building or house number in the street address (e.g. 123 Main St).';
    }
  }

  // 3. Street Address Line 2 Validation (Optional)
  const street2Trimmed = (data.street2 || '').trim();
  if (street2Trimmed.length > 50) {
    errors.street2 = 'Address line 2 must not exceed 50 characters.';
  }

  // 4. City Validation
  const cityTrimmed = (data.city || '').trim();
  if (!cityTrimmed) {
    errors.city = 'City / Town is required.';
  } else if (cityTrimmed.length < 2) {
    errors.city = 'City name is too short.';
  } else if (cityTrimmed.length > 50) {
    errors.city = 'City name must not exceed 50 characters.';
  }

  // 5. State / Province / Territory Validation
  const stateTrimmed = (data.state || '').trim();
  if (config.hasStates) {
    if (config.states && config.states.length > 0) {
      // Must be one of the recognized subdivision codes
      if (!stateTrimmed) {
        errors.state = `Please select a ${config.stateLabel} for ${config.name}.`;
      } else {
        const matched = config.states.some(
          (s) => s.code.toUpperCase() === stateTrimmed.toUpperCase(),
        );
        if (!matched) {
          errors.state = `Invalid ${config.stateLabel} code. Please select from the list.`;
        }
      }
    } else if (config.isAvsStrict && !stateTrimmed) {
      errors.state = `${config.stateLabel} is required for AVS verification in ${config.name}.`;
    }
  }

  // 6. Postal / ZIP Code Validation
  const postalTrimmed = (data.postalCode || '').trim();
  if (config.postalRequired && !postalTrimmed) {
    errors.postalCode = `${config.postalLabel} is required for cards issued in ${config.name}.`;
  } else if (postalTrimmed) {
    if (config.postalPattern) {
      if (!config.postalPattern.test(postalTrimmed)) {
        errors.postalCode = getPostalFormatErrorMessage(config);
      }
    } else if (postalTrimmed.length < 2 || postalTrimmed.length > 12) {
      errors.postalCode = `Invalid ${config.postalLabel} format.`;
    }
  }

  const errorKeys = Object.keys(errors);
  const isValid = errorKeys.length === 0;
  const firstError = isValid ? undefined : errors[errorKeys[0]!];

  return {
    isValid,
    errors,
    warnings,
    firstError,
  };
}

/**
 * Returns human-readable error messages for country-specific postal formats
 */
function getPostalFormatErrorMessage(config: CountryConfig): string {
  switch (config.code) {
    case 'US':
      return 'US ZIP Code must be 5 digits (e.g. 90210) or 9 digits ZIP+4 (e.g. 90210-1234).';
    case 'GB':
      return 'Invalid UK Postcode. Please enter a valid UK postcode (e.g. SW1A 1AA or EC1A 1BB).';
    case 'CA':
      return 'Canadian Postal Code must be in A1A 1A1 format (e.g. M5V 2T6).';
    case 'SG':
      return 'Singapore Postal Code must be exactly 6 digits (e.g. 048581).';
    case 'AU':
      return 'Australian Postcode must be exactly 4 digits (e.g. 2000).';
    case 'NZ':
      return 'New Zealand Postcode must be exactly 4 digits (e.g. 1010).';
    case 'JP':
      return 'Japanese Postal Code must be 7 digits (e.g. 100-0001 or 1000001).';
    case 'NL':
      return 'Netherlands Postcode must be 4 digits followed by 2 letters (e.g. 1012 JS).';
    case 'DE':
    case 'FR':
    case 'IT':
    case 'ES':
      return `${config.name} ${config.postalLabel} must be exactly 5 digits (e.g. 75001).`;
    case 'CN':
    case 'IN':
      return `${config.name} ${config.postalLabel} must be exactly 6 digits.`;
    default:
      return `Invalid ${config.postalLabel} format for ${config.name}. Example: ${config.postalPlaceholder}`;
  }
}

/**
 * Clean and normalize AVS address fields before tokenizing with Omise.js
 */
export function normalizeAvsForToken(
  data: BillingAddressData,
  config: CountryConfig,
): {
  country: string;
  street1: string;
  street2?: string;
  city: string;
  state?: string;
  postal_code?: string;
} {
  const normalizedCountry = config.code.toUpperCase();
  const normalizedStreet1 = data.street1.trim().slice(0, 50);
  const normalizedStreet2 = data.street2 ? data.street2.trim().slice(0, 50) : undefined;
  const normalizedCity = data.city.trim().slice(0, 50);

  let normalizedState: string | undefined = undefined;
  if (config.hasStates && data.state) {
    normalizedState = data.state.trim().toUpperCase().slice(0, 50);
  }

  let normalizedPostal: string | undefined = undefined;
  if (data.postalCode && data.postalCode.trim()) {
    normalizedPostal = formatPostalCode(normalizedCountry, data.postalCode).trim().slice(0, 16);
  }

  const result: {
    country: string;
    street1: string;
    street2?: string;
    city: string;
    state?: string;
    postal_code?: string;
  } = {
    country: normalizedCountry,
    street1: normalizedStreet1,
    city: normalizedCity,
  };

  if (normalizedStreet2) {
    result.street2 = normalizedStreet2;
  }
  if (normalizedState) {
    result.state = normalizedState;
  }
  if (normalizedPostal) {
    result.postal_code = normalizedPostal;
  }

  return result;
}
