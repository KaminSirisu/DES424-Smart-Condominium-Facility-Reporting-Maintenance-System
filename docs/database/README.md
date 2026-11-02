# Database design

The proposed DynamoDB keys, indexes, and API access patterns are in [DynamoDB access patterns](dynamodb-access-patterns.md). This is a design draft for SCFRMS-28; create AWS tables only after the open API and reporting decisions in that document are resolved.

The reporter enters `location` as free text. There is no zone ID or zone catalog. Staff use one shared account per team under the current plan. These decisions supersede the earlier individual-staff example that was previously in this file.
