/** Result of lookupProperty() — public-record facts about an address. */

export type SourceStatus = 'ok' | 'empty' | 'error' | 'skipped';

export interface SourceReport {
  name: string;
  status: SourceStatus;
  message?: string;
}

export interface LookupAddress {
  /** e.g. "1600 PENNSYLVANIA AVE NW" */
  line1: string;
  /** e.g. "WASHINGTON, DC 20500" */
  line2: string;
  full: string;
  county?: string;
  state?: string;
}

export interface BuildingFootprint {
  /** Width of the street-facing side (feet). */
  facadeWidthFt: number;
  /** Depth perpendicular to the street (feet). */
  depthFt: number;
  footprintSqFt: number;
  levels: number | null;
  heightFt: number | null;
  roofShape: string | null;
  roofMaterial: string | null;
  wallMaterial: string | null;
  startDate: string | null;
  /** How the building was matched to the address. */
  match: 'geocoder' | 'address' | 'contains' | 'nearest';
  /** Street used to decide which side is the front. */
  street: string | null;
  url: string;
}

export interface AssessorRecord {
  provider: 'RentCast' | 'ATTOM';
  yearBuilt: number | null;
  livingAreaSqFt: number | null;
  lotSizeSqFt: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  stories: number | null;
  propertyType: string | null;
  parcelId: string | null;
  subdivision: string | null;
  legalDescription: string | null;
  county: string | null;
  architectureType: string | null;
  exteriorType: string | null;
  roofType: string | null;
  garageType: string | null;
  garageSpaces: number | null;
  foundationType: string | null;
  zoning: string | null;
}

export interface PropertyLookup {
  query: string;
  address: LookupAddress | null;
  location: { lat: number; lon: number } | null;
  elevationFt: number | null;
  building: BuildingFootprint | null;
  record: AssessorRecord | null;
  sources: SourceReport[];
}
